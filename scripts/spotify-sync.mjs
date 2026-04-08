import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

function loadEnvFile() {
  const envPath = path.resolve(".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  const contents = fs.readFileSync(envPath, "utf8");

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function stableUuid(prefix, value) {
  const hash = crypto.createHash("md5").update(`${prefix}:${value}`).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

function getReleaseLookupKey(artistId, slug) {
  return `${artistId}:${slug}`;
}

function getSpotifyArtistIdFromUrl(url) {
  if (!url) {
    return null;
  }

  const match = url.match(/open\.spotify\.com\/artist\/([A-Za-z0-9]+)/i);
  return match?.[1] || null;
}

async function getSpotifyAccessToken() {
  const clientId = getRequiredEnv("SPOTIFY_CLIENT_ID");
  const clientSecret = getRequiredEnv("SPOTIFY_CLIENT_SECRET");
  const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authHeader}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
    }),
  });

  if (!response.ok) {
    throw new Error(`Spotify token request failed: ${response.status}`);
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error("Spotify token response did not include an access token");
  }

  return data.access_token;
}

async function spotifyFetch(pathname, accessToken) {
  const response = await fetch(`${SPOTIFY_API_BASE}${pathname}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Spotify API request failed for ${pathname}: ${response.status}${
        errorBody ? ` ${errorBody}` : ""
      }`
    );
  }

  return response.json();
}

async function fetchArtistAlbums(artistId, accessToken) {
  const seen = new Map();
  let nextPath = `/artists/${artistId}/albums?include_groups=album,single`;

  while (nextPath) {
    const payload = await spotifyFetch(nextPath, accessToken);

    for (const album of payload.items || []) {
      if (!seen.has(album.id)) {
        seen.set(album.id, album);
      }
    }

    nextPath = payload.next ? payload.next.replace(`${SPOTIFY_API_BASE}`, "") : "";
  }

  return Array.from(seen.values());
}

async function searchSpotifyArtistByName(name, accessToken) {
  const query = encodeURIComponent(`artist:${name}`);
  const payload = await spotifyFetch(`/search?q=${query}&type=artist&limit=10`, accessToken);
  const items = payload?.artists?.items || [];
  const normalizedName = name.trim().toLowerCase();

  const exactMatch =
    items.find((item) => item.name?.trim().toLowerCase() === normalizedName) || null;

  return exactMatch || items[0] || null;
}

async function buildSpotifyArtistSources(supabase) {
  const { data: artists, error: artistsError } = await supabase.from("artists").select("id, name");

  if (artistsError) {
    throw artistsError;
  }

  const { data, error } = await supabase
    .from("artist_links")
    .select("artist_id, platform, url, external_account_id");

  if (error) {
    throw error;
  }

  const artistNameById = new Map((artists || []).map((artist) => [artist.id, artist.name]));

  return (data || []).reduce((map, link) => {
    if ((link.platform || "").toLowerCase() !== "spotify") {
      return map;
    }

    const spotifyArtistId = link.external_account_id || getSpotifyArtistIdFromUrl(link.url);

    if (spotifyArtistId && link.artist_id) {
      map[spotifyArtistId] = {
        artistId: link.artist_id,
        artistName: artistNameById.get(link.artist_id) || "Unknown artist",
      };
    }

    return map;
  }, {});
}

function toReleaseRows(albumsByArtist, existingReleaseIdByKey) {
  return albumsByArtist
    .map(({ artistId, album }) => {
      if (!artistId) {
        return null;
      }

      const slug = slugify(album.name);
      const existingReleaseId = existingReleaseIdByKey.get(getReleaseLookupKey(artistId, slug));

      return {
        id: existingReleaseId || stableUuid("spotify-release", album.id),
        artist_id: artistId,
        title: album.name,
        slug,
        release_type: album.album_type,
        release_date: album.release_date,
        cover_image_url: album.images?.[0]?.url ?? null,
        description: null,
      };
    })
    .filter(Boolean);
}

function toReleaseLinkRows(albumsByArtist, existingReleaseIdByKey) {
  return albumsByArtist
    .map(({ artistId, album }) => {
      if (!artistId || !album.external_urls?.spotify) {
        return null;
      }

      const slug = slugify(album.name);
      const existingReleaseId = existingReleaseIdByKey.get(getReleaseLookupKey(artistId, slug));

      return {
        id: stableUuid("spotify-release-link", album.id),
        release_id: existingReleaseId || stableUuid("spotify-release", album.id),
        platform: "spotify",
        url: album.external_urls.spotify,
        embed_url: `https://open.spotify.com/embed/album/${album.id}`,
      };
    })
    .filter(Boolean);
}

async function main() {
  loadEnvFile();

  const supabase = createClient(
    getRequiredEnv("VITE_SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY")
  );
  const spotifyArtistIds = getRequiredEnv("SPOTIFY_ARTIST_IDS")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const artistSources = await buildSpotifyArtistSources(supabase);
  const artistIds = Array.from(
    new Set(Object.values(artistSources).map((source) => source.artistId).filter(Boolean))
  );
  const existingReleases = artistIds.length
    ? await (async () => {
        const { data, error } = await supabase
          .from("releases")
          .select("id, artist_id, slug")
          .in("artist_id", artistIds);

        if (error) {
          throw error;
        }

        return data || [];
      })()
    : [];
  const existingReleaseIdByKey = new Map(
    existingReleases.map((release) => [getReleaseLookupKey(release.artist_id, release.slug), release.id])
  );
  const accessToken = await getSpotifyAccessToken();
  const albumsByArtist = [];
  const failedArtists = [];

  for (const spotifyArtistId of spotifyArtistIds) {
    const source = artistSources[spotifyArtistId];

    try {
      const albums = await fetchArtistAlbums(spotifyArtistId, accessToken);

      for (const album of albums) {
        albumsByArtist.push({
          artistId: source?.artistId || null,
          spotifyArtistId,
          album,
        });
      }
    } catch (error) {
      if (!source?.artistName) {
        failedArtists.push({
          spotifyArtistId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      try {
        const resolvedArtist = await searchSpotifyArtistByName(source.artistName, accessToken);

        if (!resolvedArtist?.id) {
          throw new Error(`No Spotify artist match found for ${source.artistName}`);
        }

        const albums = await fetchArtistAlbums(resolvedArtist.id, accessToken);

        for (const album of albums) {
          albumsByArtist.push({
            artistId: source.artistId,
            spotifyArtistId: resolvedArtist.id,
            album,
          });
        }
      } catch (fallbackError) {
        failedArtists.push({
          spotifyArtistId,
          artistName: source.artistName,
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
      }
    }
  }

  const releaseRows = toReleaseRows(albumsByArtist, existingReleaseIdByKey);
  const releaseLinkRows = toReleaseLinkRows(albumsByArtist, existingReleaseIdByKey);

  const { error: releaseError } = await supabase
    .from("releases")
    .upsert(releaseRows, { onConflict: "id" });

  if (releaseError) {
    throw releaseError;
  }

  const { error: releaseLinkError } = await supabase
    .from("release_links")
    .upsert(releaseLinkRows, { onConflict: "id" });

  if (releaseLinkError) {
    throw releaseLinkError;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        spotifyArtistIds,
        mappedArtistCount: Object.keys(artistSources).length,
        releaseCount: releaseRows.length,
        releaseLinkCount: releaseLinkRows.length,
        failedArtists,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SOUNDCLOUD_TOKEN_URL = "https://secure.soundcloud.com/oauth/token";
const SOUNDCLOUD_API_BASE = "https://api.soundcloud.com";
const DEFAULT_IMPORT_START_DATE = "2026-04-06";

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

function slugify(value) {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function getPermalinkFromUrl(url) {
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/+|\/+$/g, "");
  } catch {
    return url.replace(/^https?:\/\/[^/]+\//i, "").replace(/^\/+|\/+$/g, "");
  }
}

function getEmbedUrl(url) {
  if (!url) {
    return null;
  }

  return `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}`;
}

function getBestSoundCloudArtworkUrl(url) {
  if (!url) {
    return null;
  }

  return url.replace(/-(large|t\d+x\d+|crop|original)\./i, "-original.");
}

async function getSoundCloudAccessToken() {
  const clientId = getRequiredEnv("SOUNDCLOUD_CLIENT_ID");
  const clientSecret = getRequiredEnv("SOUNDCLOUD_CLIENT_SECRET");
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(SOUNDCLOUD_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      `SoundCloud token request failed: ${response.status} ${
        data?.error_description || data?.error || response.statusText
      }`
    );
  }

  if (!data?.access_token) {
    throw new Error("SoundCloud token response did not include an access token");
  }

  return data.access_token;
}

async function soundcloudFetch(pathname, accessToken, searchParams = {}) {
  const url = new URL(pathname, SOUNDCLOUD_API_BASE);

  Object.entries(searchParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      `SoundCloud API request failed for ${url.pathname}: ${response.status} ${
        data?.error_description || data?.error || response.statusText
      }`
    );
  }

  return data;
}

async function resolveSoundCloudUrl(url, accessToken) {
  return soundcloudFetch("/resolve", accessToken, { url });
}

async function fetchPaginatedCollection(pathname, accessToken, searchParams = {}) {
  const items = [];
  let nextUrl = new URL(pathname, SOUNDCLOUD_API_BASE);

  Object.entries({
    linked_partitioning: "1",
    limit: 200,
    ...searchParams,
  }).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      nextUrl.searchParams.set(key, String(value));
    }
  });

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(
        `SoundCloud API request failed for ${nextUrl.pathname}: ${response.status} ${
          data?.error_description || data?.error || response.statusText
        }`
      );
    }

    const collection = Array.isArray(data?.collection) ? data.collection : [];
    items.push(...collection);
    nextUrl = data?.next_href ? new URL(data.next_href) : null;
  }

  return items;
}

async function buildSoundCloudArtistSources(supabase, accessToken) {
  const [{ data: artists, error: artistsError }, { data: artistLinks, error: artistLinksError }] =
    await Promise.all([
      supabase.from("artists").select("id, name, slug"),
      supabase
        .from("artist_links")
        .select("id, artist_id, platform, url, handle, external_account_id")
        .eq("platform", "soundcloud"),
    ]);

  if (artistsError) {
    throw artistsError;
  }

  if (artistLinksError) {
    throw artistLinksError;
  }

  const artistById = new Map((artists || []).map((artist) => [artist.id, artist]));
  const sources = [];

  for (const link of artistLinks || []) {
    if (!link.artist_id || !link.url) {
      continue;
    }

    const artist = artistById.get(link.artist_id);

    if (!artist) {
      continue;
    }

    const resolved = await resolveSoundCloudUrl(link.url, accessToken);
    const resolvedUserId = resolved?.kind === "user" ? resolved.id : resolved?.user?.id;

    if (!resolvedUserId) {
      throw new Error(`Could not resolve SoundCloud user for ${link.url}`);
    }

    sources.push({
      artistId: artist.id,
      artistName: artist.name,
      artistSlug: artist.slug || String(artist.id),
      linkId: link.id,
      profileUrl: link.url,
      userId: resolvedUserId,
      permalink: resolved?.permalink || getPermalinkFromUrl(link.url),
      avatarUrl: resolved?.avatar_url || null,
    });
  }

  return sources;
}

async function hasColumn(baseUrl, serviceRoleKey, table, column) {
  const response = await fetch(
    `${baseUrl}/rest/v1/${table}?select=${encodeURIComponent(column)}&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: "application/json",
      },
    }
  );

  if (response.ok) {
    return true;
  }

  const error = await response.json().catch(() => null);

  if (error?.code === "42703") {
    return false;
  }

  throw new Error(
    `Could not verify ${table}.${column}: ${response.status} ${
      error?.message || response.statusText
    }`
  );
}

function normalizeTrackEntry(item, source) {
  if (!item?.permalink_url || !item?.title) {
    return null;
  }

  return {
    kind: "track",
    artistId: source.artistId,
    artistName: source.artistName,
    title: item.title,
    slug: item.permalink || slugify(item.title),
    url: item.permalink_url,
    releaseType: "track",
    releaseDate: item.release_date || item.display_date || item.created_at || null,
    coverImageUrl: getBestSoundCloudArtworkUrl(
      item.artwork_url || item.user?.avatar_url || source.avatarUrl || null
    ),
    description: item.description || null,
    durationMs: typeof item.duration === "number" ? item.duration : null,
  };
}

function normalizePlaylistEntry(item, source) {
  if (!item?.permalink_url || !item?.title) {
    return null;
  }

  return {
    kind: "playlist",
    artistId: source.artistId,
    artistName: source.artistName,
    title: item.title,
    slug: item.permalink || slugify(item.title),
    url: item.permalink_url,
    releaseType: "playlist",
    releaseDate: item.release_date || item.created_at || null,
    coverImageUrl: getBestSoundCloudArtworkUrl(
      item.artwork_url || item.user?.avatar_url || source.avatarUrl || null
    ),
    description: item.description || null,
    durationMs: typeof item.duration === "number" ? item.duration : null,
  };
}

function getReleaseLookupKey(artistId, slug) {
  return `${artistId}:${slug}`;
}

function toReleaseDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function isOnOrAfterStartDate(value, startDate) {
  const releaseDate = toReleaseDate(value);

  if (!releaseDate) {
    return false;
  }

  return releaseDate >= startDate;
}

async function main() {
  loadEnvFile();

  const supabaseUrl = getRequiredEnv("VITE_SUPABASE_URL");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const includePlaylists = (process.env.SOUNDCLOUD_INCLUDE_PLAYLISTS || "true").toLowerCase() !== "false";
  const importStartDate = process.env.SOUNDCLOUD_IMPORT_START_DATE || DEFAULT_IMPORT_START_DATE;
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const accessToken = await getSoundCloudAccessToken();
  const durationColumnExists = await hasColumn(supabaseUrl, serviceRoleKey, "releases", "duration_ms");
  const artistSources = await buildSoundCloudArtistSources(supabase, accessToken);

  if (!artistSources.length) {
    throw new Error("No SoundCloud artist links found. Add soundcloud artist_links first.");
  }

  const allEntries = [];
  const failedArtists = [];

  for (const source of artistSources) {
    try {
      const tracks = await fetchPaginatedCollection(
        `/users/${source.userId}/tracks`,
        accessToken,
        {
          representation: "full",
        }
      );

      const publicTracks = tracks
        .filter((item) => (item?.sharing || "").toLowerCase() === "public")
        .map((item) => normalizeTrackEntry(item, source))
        .filter((entry) => isOnOrAfterStartDate(entry?.releaseDate, importStartDate))
        .filter(Boolean);

      allEntries.push(...publicTracks);

      if (includePlaylists) {
        const playlists = await fetchPaginatedCollection(
          `/users/${source.userId}/playlists`,
          accessToken,
          {
            representation: "full",
          }
        );

        const publicPlaylists = playlists
          .filter((item) => (item?.sharing || "").toLowerCase() === "public")
          .map((item) => normalizePlaylistEntry(item, source))
          .filter((entry) => isOnOrAfterStartDate(entry?.releaseDate, importStartDate))
          .filter(Boolean);

        allEntries.push(...publicPlaylists);
      }
    } catch (error) {
      failedArtists.push({
        artistId: source.artistId,
        artistName: source.artistName,
        profileUrl: source.profileUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const artistIds = Array.from(new Set(allEntries.map((entry) => entry.artistId).filter(Boolean)));
  let existingReleases = [];

  if (artistIds.length) {
    const { data, error } = await supabase
      .from("releases")
      .select("id, artist_id, slug")
      .in("artist_id", artistIds);

    if (error) {
      throw error;
    }

    existingReleases = data || [];
  }

  const existingReleaseIdByKey = new Map(
    existingReleases.map((release) => [getReleaseLookupKey(release.artist_id, release.slug), release.id])
  );

  const releaseRows = allEntries.map((entry) => {
    const existingReleaseId = existingReleaseIdByKey.get(
      getReleaseLookupKey(entry.artistId, entry.slug)
    );
    const row = {
      id: existingReleaseId || stableUuid("soundcloud-release", entry.url),
      artist_id: entry.artistId,
      title: entry.title,
      slug: entry.slug,
      release_type: entry.releaseType,
      release_date: toReleaseDate(entry.releaseDate),
      cover_image_url: entry.coverImageUrl,
      description: entry.description,
    };

    if (durationColumnExists) {
      row.duration_ms = entry.durationMs;
    }

    return row;
  });

  const releaseLinkRows = allEntries.map((entry) => {
    const existingReleaseId = existingReleaseIdByKey.get(
      getReleaseLookupKey(entry.artistId, entry.slug)
    );

    return {
      id: stableUuid("soundcloud-release-link", entry.url),
      release_id: existingReleaseId || stableUuid("soundcloud-release", entry.url),
      platform: "soundcloud",
      url: entry.url,
      embed_url: getEmbedUrl(entry.url),
    };
  });

  if (releaseRows.length) {
    const { error: releaseError } = await supabase
      .from("releases")
      .upsert(releaseRows, { onConflict: "id" });

    if (releaseError) {
      throw releaseError;
    }
  }

  if (releaseLinkRows.length) {
    const { error: releaseLinkError } = await supabase
      .from("release_links")
      .upsert(releaseLinkRows, { onConflict: "id" });

    if (releaseLinkError) {
      throw releaseLinkError;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        artistCount: artistSources.length,
        importedEntryCount: allEntries.length,
        releaseCount: releaseRows.length,
        releaseLinkCount: releaseLinkRows.length,
        durationColumnExists,
        includePlaylists,
        importStartDate,
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

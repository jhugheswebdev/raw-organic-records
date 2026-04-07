import crypto from "node:crypto";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

export type SpotifyTrack = {
  id: string;
  name: string;
  track_number: number;
  duration_ms: number;
  external_urls?: {
    spotify?: string;
  };
};

export type SpotifyAlbum = {
  id: string;
  name: string;
  release_date: string;
  album_type: string;
  artists?: Array<{
    id: string;
    name: string;
  }>;
  external_urls?: {
    spotify?: string;
  };
  images?: Array<{
    url: string;
    width: number | null;
    height: number | null;
  }>;
};

export type SpotifyAlbumWithTracks = {
  spotifyArtistId: string;
  album: SpotifyAlbum;
  tracks: SpotifyTrack[];
};

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function spotifyFetch<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`${SPOTIFY_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Spotify API request failed for ${path}: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function getSpotifyAccessToken(): Promise<string> {
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

  const data = (await response.json()) as { access_token?: string };

  if (!data.access_token) {
    throw new Error("Spotify token response did not include an access token");
  }

  return data.access_token;
}

export function getSpotifyArtistIds(): string[] {
  const raw = getRequiredEnv("SPOTIFY_ARTIST_IDS");

  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export async function fetchArtistAlbums(
  artistId: string,
  accessToken: string
): Promise<SpotifyAlbum[]> {
  const seen = new Map<string, SpotifyAlbum>();
  let nextPath = `/artists/${artistId}/albums?include_groups=album,single`;

  while (nextPath) {
    const payload = await spotifyFetch<{
      items: SpotifyAlbum[];
      next: string | null;
    }>(nextPath, accessToken);

    for (const album of payload.items) {
      if (!seen.has(album.id)) {
        seen.set(album.id, album);
      }
    }

    nextPath = payload.next ? payload.next.replace(`${SPOTIFY_API_BASE}`, "") : "";
  }

  return Array.from(seen.values());
}

export async function fetchAlbumTracks(
  albumId: string,
  accessToken: string
): Promise<SpotifyTrack[]> {
  const tracks: SpotifyTrack[] = [];
  let nextPath = `/albums/${albumId}/tracks?limit=50`;

  while (nextPath) {
    const payload = await spotifyFetch<{
      items: SpotifyTrack[];
      next: string | null;
    }>(nextPath, accessToken);

    tracks.push(...payload.items);
    nextPath = payload.next ? payload.next.replace(`${SPOTIFY_API_BASE}`, "") : "";
  }

  return tracks;
}

export async function fetchAlbumsAndTracksForArtists(
  artistIds: string[]
): Promise<SpotifyAlbumWithTracks[]> {
  const accessToken = await getSpotifyAccessToken();
  const results: SpotifyAlbumWithTracks[] = [];

  for (const artistId of artistIds) {
    const albums = await fetchArtistAlbums(artistId, accessToken);

    for (const album of albums) {
      const tracks = await fetchAlbumTracks(album.id, accessToken);
      results.push({
        spotifyArtistId: artistId,
        album,
        tracks,
      });
    }
  }

  return results;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function stableUuid(prefix: string, value: string): string {
  const hash = crypto.createHash("md5").update(`${prefix}:${value}`).digest("hex");

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

export function getSpotifyArtistIdFromUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }

  const match = url.match(/open\.spotify\.com\/artist\/([A-Za-z0-9]+)/i);
  return match?.[1] || null;
}

export function toReleaseRows(
  items: SpotifyAlbumWithTracks[],
  artistMap: Record<string, string>
) {
  return items
    .map(({ spotifyArtistId, album }) => {
      const localArtistId = artistMap[spotifyArtistId];

      if (!localArtistId) {
        return null;
      }

      return {
        id: stableUuid("spotify-release", album.id),
        artist_id: localArtistId,
        title: album.name,
        slug: slugify(album.name),
        release_type: album.album_type,
        release_date: album.release_date,
        cover_image_url: album.images?.[0]?.url ?? null,
        description: null,
      };
    })
    .filter(Boolean);
}

export function toReleaseLinkRows(
  items: SpotifyAlbumWithTracks[],
  artistMap: Record<string, string>
) {
  return items
    .map(({ spotifyArtistId, album }) => {
      const localArtistId = artistMap[spotifyArtistId];

      if (!localArtistId || !album.external_urls?.spotify) {
        return null;
      }

      return {
        id: stableUuid("spotify-release-link", album.id),
        release_id: stableUuid("spotify-release", album.id),
        platform: "spotify",
        url: album.external_urls.spotify,
        embed_url: `https://open.spotify.com/embed/album/${album.id}`,
      };
    })
    .filter(Boolean);
}

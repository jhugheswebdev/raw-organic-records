import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const X_API_BASE = "https://api.x.com/2";
const DEFAULT_MAX_RESULTS = 10;

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

function getJsonEnv(name, fallback = null) {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Environment variable ${name} must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function getHandleFromUrl(url) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);

    if (!/(^|\.)x\.com$/i.test(parsed.hostname) && !/(^|\.)twitter\.com$/i.test(parsed.hostname)) {
      return null;
    }

    const [firstSegment = ""] = parsed.pathname.replace(/^\/+/, "").split("/");
    return firstSegment ? firstSegment.replace(/^@/, "") : null;
  } catch {
    return null;
  }
}

function normalizeHandle(value) {
  return (value || "").trim().replace(/^@/, "");
}

function truncateText(value, maxLength = 280) {
  const text = (value || "").trim();

  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

async function xFetch(pathname, bearerToken, searchParams = {}) {
  const url = new URL(pathname, X_API_BASE);

  Object.entries(searchParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: "application/json",
    },
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      `X API request failed for ${url.pathname}: ${response.status} ${
        data?.detail || data?.title || response.statusText
      }`
    );
  }

  return data;
}

async function buildXArtistSources(supabase) {
  const [{ data: artists, error: artistsError }, { data: artistLinks, error: artistLinksError }] =
    await Promise.all([
      supabase.from("artists").select("id, name, slug"),
      supabase
        .from("artist_links")
        .select("id, artist_id, platform, url, handle, external_account_id")
        .in("platform", ["x", "twitter"]),
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
    const artist = artistById.get(link.artist_id);

    if (!artist) {
      continue;
    }

    const handle = normalizeHandle(link.handle || getHandleFromUrl(link.url));
    const externalAccountId = (link.external_account_id || "").trim() || null;

    if (!handle && !externalAccountId) {
      continue;
    }

    sources.push({
      artistId: artist.id,
      artistName: artist.name,
      artistSlug: artist.slug || String(artist.id),
      handle,
      externalAccountId,
      profileUrl: link.url || (handle ? `https://x.com/${handle}` : null),
    });
  }

  const envMap = getJsonEnv("X_ARTIST_HANDLES", {});

  for (const [artistId, handleValue] of Object.entries(envMap || {})) {
    const artist = artistById.get(artistId);
    const handle = normalizeHandle(handleValue);

    if (!artist || !handle) {
      continue;
    }

    if (sources.some((source) => source.artistId === artistId && source.handle === handle)) {
      continue;
    }

    sources.push({
      artistId: artist.id,
      artistName: artist.name,
      artistSlug: artist.slug || String(artist.id),
      handle,
      externalAccountId: null,
      profileUrl: `https://x.com/${handle}`,
    });
  }

  return sources;
}

async function resolveUserId(source, bearerToken) {
  if (source.externalAccountId) {
    return source.externalAccountId;
  }

  if (!source.handle) {
    throw new Error(`No X handle configured for ${source.artistName}`);
  }

  const payload = await xFetch(`/users/by/username/${encodeURIComponent(source.handle)}`, bearerToken, {
    "user.fields": "id,name,username",
  });

  if (!payload?.data?.id) {
    throw new Error(`Could not resolve X user for @${source.handle}`);
  }

  return payload.data.id;
}

async function fetchUserPosts(userId, bearerToken, maxResults) {
  const payload = await xFetch(`/users/${userId}/tweets`, bearerToken, {
    expansions: "attachments.media_keys",
    exclude: "replies,retweets",
    "media.fields": "media_key,preview_image_url,type,url",
    "tweet.fields": "attachments,created_at,entities,id,text",
    max_results: maxResults,
  });

  return {
    tweets: Array.isArray(payload?.data) ? payload.data : [],
    mediaByKey: new Map((payload?.includes?.media || []).map((item) => [item.media_key, item])),
  };
}

function getPostMedia(tweet, mediaByKey) {
  const mediaKeys = tweet?.attachments?.media_keys || [];

  for (const mediaKey of mediaKeys) {
    const media = mediaByKey.get(mediaKey);

    if (media?.url || media?.preview_image_url) {
      return {
        mediaUrl: media.url || media.preview_image_url,
        mediaType: media.type || null,
      };
    }
  }

  return {
    mediaUrl: null,
    mediaType: null,
  };
}

function toSocialPostRow(source, tweet, mediaByKey) {
  const permalinkHandle = source.handle || source.artistSlug;
  const { mediaUrl, mediaType } = getPostMedia(tweet, mediaByKey);
  const text = (tweet?.text || "").trim();

  return {
    id: stableUuid("x-social-post", tweet.id),
    artist_id: source.artistId,
    platform: "x",
    external_post_id: tweet.id,
    post_url: `https://x.com/${permalinkHandle}/status/${tweet.id}`,
    content_text: text || null,
    media_url: mediaUrl,
    media_type: mediaType,
    embed_html: null,
    posted_at: tweet.created_at || null,
    ingested_at: new Date().toISOString(),
    is_featured: false,
    is_visible: true,
    title: truncateText(text, 80) || "X update",
    content: text || null,
    post_type: mediaType || "post",
    source: "X",
    slug: tweet.id,
  };
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

function filterToExistingColumns(rows, availableColumns) {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => availableColumns.has(key)))
  );
}

async function main() {
  loadEnvFile();

  const supabaseUrl = getRequiredEnv("VITE_SUPABASE_URL");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const bearerToken = getRequiredEnv("X_BEARER_TOKEN");
  const maxResults = Number(process.env.X_MAX_RESULTS || DEFAULT_MAX_RESULTS);
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const artistSources = await buildXArtistSources(supabase);

  if (!artistSources.length) {
    throw new Error(
      "No X artist sources found. Add x/twitter artist_links or set X_ARTIST_HANDLES in .env."
    );
  }

  const optionalColumns = [
    "title",
    "content",
    "post_type",
    "source",
    "slug",
  ];
  const availableColumns = new Set([
    "id",
    "artist_id",
    "platform",
    "external_post_id",
    "post_url",
    "content_text",
    "media_url",
    "media_type",
    "embed_html",
    "posted_at",
    "ingested_at",
    "is_featured",
    "is_visible",
  ]);

  for (const column of optionalColumns) {
    if (await hasColumn(supabaseUrl, serviceRoleKey, "social_posts", column)) {
      availableColumns.add(column);
    }
  }

  const allRows = [];
  const failedArtists = [];

  for (const source of artistSources) {
    try {
      const userId = await resolveUserId(source, bearerToken);
      const { tweets, mediaByKey } = await fetchUserPosts(userId, bearerToken, maxResults);

      for (const tweet of tweets) {
        allRows.push(toSocialPostRow({ ...source, externalAccountId: userId }, tweet, mediaByKey));
      }
    } catch (error) {
      failedArtists.push({
        artistId: source.artistId,
        artistName: source.artistName,
        handle: source.handle || null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const rows = filterToExistingColumns(allRows, availableColumns);

  if (rows.length) {
    const { error } = await supabase.from("social_posts").upsert(rows, { onConflict: "id" });

    if (error) {
      throw error;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        artistCount: artistSources.length,
        importedPostCount: rows.length,
        availableColumns: Array.from(availableColumns),
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

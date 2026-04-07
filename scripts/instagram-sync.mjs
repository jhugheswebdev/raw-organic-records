import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const GRAPH_API_BASE = "https://graph.facebook.com/v23.0";
const DEFAULT_LIMIT = 10;

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

function truncateText(value, maxLength = 80) {
  const text = (value || "").trim();

  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

async function graphFetch(pathname, accessToken, searchParams = {}) {
  const url = new URL(pathname, GRAPH_API_BASE);

  Object.entries(searchParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url);
  const data = await response.json().catch(() => null);

  if (!response.ok || data?.error) {
    const detail = data?.error?.message || response.statusText;
    throw new Error(`Meta Graph API request failed for ${url.pathname}: ${response.status} ${detail}`);
  }

  return data;
}

async function buildInstagramArtistSources(supabase) {
  const [{ data: artists, error: artistsError }, { data: artistLinks, error: artistLinksError }] =
    await Promise.all([
      supabase.from("artists").select("id, name, slug"),
      supabase
        .from("artist_links")
        .select("artist_id, platform, url, handle, external_account_id")
        .eq("platform", "instagram"),
    ]);

  if (artistsError) throw artistsError;
  if (artistLinksError) throw artistLinksError;

  const artistById = new Map((artists || []).map((artist) => [artist.id, artist]));
  const sources = [];

  for (const link of artistLinks || []) {
    const artist = artistById.get(link.artist_id);

    if (!artist) {
      continue;
    }

    const igUserId = (link.external_account_id || "").trim();

    if (!igUserId) {
      continue;
    }

    sources.push({
      artistId: artist.id,
      artistName: artist.name,
      artistSlug: artist.slug || String(artist.id),
      igUserId,
      profileUrl: link.url || null,
      handle: link.handle || null,
    });
  }

  const envMap = getJsonEnv("INSTAGRAM_ARTIST_USERS", {});

  for (const [artistId, userIdValue] of Object.entries(envMap || {})) {
    const artist = artistById.get(artistId);
    const igUserId = String(userIdValue || "").trim();

    if (!artist || !igUserId) {
      continue;
    }

    if (sources.some((source) => source.artistId === artistId && source.igUserId === igUserId)) {
      continue;
    }

    sources.push({
      artistId: artist.id,
      artistName: artist.name,
      artistSlug: artist.slug || String(artist.id),
      igUserId,
      profileUrl: null,
      handle: null,
    });
  }

  return sources;
}

function toSocialPostRow(source, media) {
  const caption = (media?.caption || "").trim();
  const mediaUrl = media?.media_url || media?.thumbnail_url || null;

  return {
    id: stableUuid("instagram-social-post", media.id),
    artist_id: source.artistId,
    platform: "instagram",
    external_post_id: media.id,
    post_url: media.permalink || source.profileUrl,
    content_text: caption || null,
    media_url: mediaUrl,
    media_type: media.media_type || null,
    embed_html: null,
    posted_at: media.timestamp || null,
    ingested_at: new Date().toISOString(),
    is_featured: false,
    is_visible: true,
    title: truncateText(caption) || "Instagram update",
    content: caption || null,
    post_type: media.media_type || "post",
    source: "IG",
    slug: media.id,
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
  const accessToken = getRequiredEnv("INSTAGRAM_ACCESS_TOKEN");
  const limit = Number(process.env.INSTAGRAM_POST_LIMIT || DEFAULT_LIMIT);
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const sources = await buildInstagramArtistSources(supabase);

  if (!sources.length) {
    throw new Error(
      "No Instagram artist sources found. Add instagram artist_links with external_account_id or set INSTAGRAM_ARTIST_USERS in .env."
    );
  }

  const optionalColumns = ["title", "content", "post_type", "source", "slug"];
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

  const rows = [];
  const failedArtists = [];

  for (const source of sources) {
    try {
      const payload = await graphFetch(`/${source.igUserId}/media`, accessToken, {
        fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp",
        limit,
      });

      for (const media of payload?.data || []) {
        rows.push(toSocialPostRow(source, media));
      }
    } catch (error) {
      failedArtists.push({
        artistId: source.artistId,
        artistName: source.artistName,
        igUserId: source.igUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const filteredRows = filterToExistingColumns(rows, availableColumns);

  if (filteredRows.length) {
    const { error } = await supabase.from("social_posts").upsert(filteredRows, { onConflict: "id" });

    if (error) {
      throw error;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        artistCount: sources.length,
        importedPostCount: filteredRows.length,
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

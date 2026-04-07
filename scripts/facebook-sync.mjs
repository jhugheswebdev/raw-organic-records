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

async function buildFacebookArtistSources(supabase) {
  const [{ data: artists, error: artistsError }, { data: artistLinks, error: artistLinksError }] =
    await Promise.all([
      supabase.from("artists").select("id, name, slug"),
      supabase
        .from("artist_links")
        .select("artist_id, platform, url, handle, external_account_id")
        .eq("platform", "facebook"),
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

    const pageId = (link.external_account_id || "").trim();

    if (!pageId) {
      continue;
    }

    sources.push({
      artistId: artist.id,
      artistName: artist.name,
      artistSlug: artist.slug || String(artist.id),
      pageId,
      pageUrl: link.url || null,
    });
  }

  const envMap = getJsonEnv("FACEBOOK_ARTIST_PAGES", {});

  for (const [artistId, pageIdValue] of Object.entries(envMap || {})) {
    const artist = artistById.get(artistId);
    const pageId = String(pageIdValue || "").trim();

    if (!artist || !pageId) {
      continue;
    }

    if (sources.some((source) => source.artistId === artistId && source.pageId === pageId)) {
      continue;
    }

    sources.push({
      artistId: artist.id,
      artistName: artist.name,
      artistSlug: artist.slug || String(artist.id),
      pageId,
      pageUrl: null,
    });
  }

  return sources;
}

function extractMedia(post) {
  const attachment = post?.attachments?.data?.[0];

  if (!attachment) {
    return { mediaUrl: null, mediaType: null };
  }

  const nested = attachment?.subattachments?.data?.[0];
  const media = nested?.media || attachment?.media;

  return {
    mediaUrl: media?.image?.src || attachment?.url || null,
    mediaType: nested?.media_type || attachment?.media_type || null,
  };
}

function toSocialPostRow(source, post) {
  const { mediaUrl, mediaType } = extractMedia(post);
  const text = (post?.message || post?.story || "").trim();

  return {
    id: stableUuid("facebook-social-post", post.id),
    artist_id: source.artistId,
    platform: "facebook",
    external_post_id: post.id,
    post_url: post.permalink_url || source.pageUrl,
    content_text: text || null,
    media_url: mediaUrl,
    media_type: mediaType,
    embed_html: null,
    posted_at: post.created_time || null,
    ingested_at: new Date().toISOString(),
    is_featured: false,
    is_visible: true,
    title: truncateText(text) || "Facebook update",
    content: text || null,
    post_type: mediaType || "post",
    source: "FB",
    slug: post.id,
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
  const accessToken = getRequiredEnv("FACEBOOK_PAGE_ACCESS_TOKEN");
  const limit = Number(process.env.FACEBOOK_POST_LIMIT || DEFAULT_LIMIT);
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const sources = await buildFacebookArtistSources(supabase);

  if (!sources.length) {
    throw new Error(
      "No Facebook artist sources found. Add facebook artist_links with external_account_id or set FACEBOOK_ARTIST_PAGES in .env."
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
      const payload = await graphFetch(`/${source.pageId}/feed`, accessToken, {
        fields:
          "id,message,story,created_time,permalink_url,attachments{media_type,media,url,subattachments}",
        limit,
      });

      for (const post of payload?.data || []) {
        rows.push(toSocialPostRow(source, post));
      }
    } catch (error) {
      failedArtists.push({
        artistId: source.artistId,
        artistName: source.artistName,
        pageId: source.pageId,
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

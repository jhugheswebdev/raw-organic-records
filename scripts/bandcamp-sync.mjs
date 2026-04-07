import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

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

function titleCaseFromSlug(value) {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => {
      if (/[0-9]/.test(part) || part.length <= 3) {
        return part.toUpperCase();
      }

      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
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

function escapeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripCdata(value) {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function getTagValue(source, tag) {
  const match = source.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? escapeXml(stripCdata(match[1].trim())) : null;
}

function extractImageUrl(html) {
  if (!html) {
    return null;
  }

  const imageMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return imageMatch?.[1] || null;
}

function normalizeBandcampMusicUrl(url) {
  return url.replace(/\/+$/, "").replace(/\/(album|track)\/.+$/i, "/music");
}

async function fetchFeed(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "RawOrganicRecordsSync/1.0",
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Feed request failed for ${url}: ${response.status} ${errorBody}`.trim());
  }

  return response.text();
}

function parseRssItems(xml) {
  return Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)).map((match) => {
    const itemXml = match[1];
    const title = getTagValue(itemXml, "title");
    const link = getTagValue(itemXml, "link");
    const pubDate = getTagValue(itemXml, "pubDate");
    const description = getTagValue(itemXml, "description");

    return {
      title,
      link,
      pubDate,
      coverImageUrl: extractImageUrl(description),
      description,
    };
  });
}

function getBandcampArtistUrlsFromEnv() {
  const raw = process.env.BANDCAMP_ARTIST_URLS;

  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    throw new Error(
      `Invalid BANDCAMP_ARTIST_URLS JSON. ${error instanceof Error ? error.message : ""}`.trim()
    );
  }
}

function getBandcampReleaseUrlsFromEnv() {
  const raw = process.env.BANDCAMP_RELEASE_URLS;

  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    throw new Error(
      `Invalid BANDCAMP_RELEASE_URLS JSON. ${error instanceof Error ? error.message : ""}`.trim()
    );
  }
}

function getBandcampReleaseMetadataFromEnv() {
  const raw = process.env.BANDCAMP_RELEASE_METADATA;

  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    throw new Error(
      `Invalid BANDCAMP_RELEASE_METADATA JSON. ${error instanceof Error ? error.message : ""}`.trim()
    );
  }
}

async function buildBandcampArtistSources(supabase) {
  const envUrls = getBandcampArtistUrlsFromEnv();
  const { data: artists, error: artistsError } = await supabase.from("artists").select("id, name");

  if (artistsError) {
    throw artistsError;
  }

  const { data: artistLinks, error: artistLinksError } = await supabase
    .from("artist_links")
    .select("artist_id, platform, url");

  if (artistLinksError) {
    throw artistLinksError;
  }

  const artistNameById = new Map((artists || []).map((artist) => [artist.id, artist.name]));
  const sources = {};

  for (const link of artistLinks || []) {
    if ((link.platform || "").toLowerCase() !== "bandcamp" || !link.url || !link.artist_id) {
      continue;
    }

    sources[link.artist_id] = {
      artistId: link.artist_id,
      artistName: artistNameById.get(link.artist_id) || "Unknown artist",
      url: normalizeBandcampMusicUrl(link.url),
    };
  }

  for (const [artistId, url] of Object.entries(envUrls)) {
    sources[artistId] = {
      artistId,
      artistName: artistNameById.get(artistId) || "Unknown artist",
      url: normalizeBandcampMusicUrl(url),
    };
  }

  return Object.values(sources);
}

function toReleaseRows(entries) {
  return entries.map((entry) => ({
    id: stableUuid("bandcamp-release", entry.link),
    artist_id: entry.artistId,
    title: entry.title || "Untitled release",
    slug: slugify(entry.title || entry.link),
    release_type: entry.releaseType || "bandcamp",
    release_date: entry.pubDate ? new Date(entry.pubDate).toISOString().slice(0, 10) : null,
    cover_image_url: entry.coverImageUrl,
    description: entry.description || null,
  }));
}

function toReleaseLinkRows(entries) {
  return entries.map((entry) => ({
    id: stableUuid("bandcamp-release-link", entry.link),
    release_id: stableUuid("bandcamp-release", entry.link),
    platform: "bandcamp",
    url: entry.link,
    embed_url: entry.link,
  }));
}

function buildSeedEntries(artistSources) {
  const releaseUrlsByArtist = getBandcampReleaseUrlsFromEnv();
  const releaseMetadataByUrl = getBandcampReleaseMetadataFromEnv();
  const entries = [];

  for (const source of artistSources) {
    const releaseUrls = releaseUrlsByArtist[source.artistId] || [];

    for (const rawUrl of releaseUrls) {
      const link = (rawUrl || "").trim();

      if (!link) {
        continue;
      }

      const match = link.match(/\/(album|track)\/([^/?#]+)/i);
      const kind = match?.[1]?.toLowerCase() || "album";
      const rawSlug = match?.[2] || link;
      const metadata = releaseMetadataByUrl[link] || {};
      const releaseSlug = metadata.release_slug || slugify(rawSlug);

      entries.push({
        artistId: source.artistId,
        artistName: source.artistName,
        title: metadata.title || titleCaseFromSlug(rawSlug),
        slug: releaseSlug,
        link,
        pubDate: metadata.release_date || null,
        coverImageUrl: metadata.cover_image_url || null,
        description: metadata.description || null,
        releaseType: kind === "track" ? "single" : "album",
      });
    }
  }

  return entries;
}

function getReleaseLookupKey(artistId, slug) {
  return `${artistId}:${slug}`;
}

async function main() {
  loadEnvFile();

  const supabase = createClient(
    getRequiredEnv("VITE_SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY")
  );
  const artistSources = await buildBandcampArtistSources(supabase);

  if (!artistSources.length) {
    throw new Error("No Bandcamp artist URLs found. Add bandcamp artist links or BANDCAMP_ARTIST_URLS.");
  }

  const seededArtistIds = Object.keys(getBandcampReleaseUrlsFromEnv());
  const entries = buildSeedEntries(artistSources);
  const failedArtists = [];

  for (const source of artistSources) {
    if (seededArtistIds.includes(source.artistId)) {
      continue;
    }

    try {
      const feedUrl = `https://openrss.org/${source.url.replace(/^https?:\/\//, "")}`;
      const xml = await fetchFeed(feedUrl);
      const items = parseRssItems(xml);

      for (const item of items) {
        if (item.link) {
          entries.push({
            ...item,
            artistId: source.artistId,
            artistName: source.artistName,
            releaseType: item.link.includes("/track/") ? "single" : "album",
          });
        }
      }
    } catch (error) {
      failedArtists.push({
        artistId: source.artistId,
        artistName: source.artistName,
        url: source.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const artistIds = Array.from(new Set(entries.map((entry) => entry.artistId).filter(Boolean)));
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
    existingReleases.map((release) => [
      getReleaseLookupKey(release.artist_id, release.slug),
      release.id,
    ])
  );

  const releaseRows = entries.map((entry) => {
    const existingReleaseId = existingReleaseIdByKey.get(
      getReleaseLookupKey(entry.artistId, entry.slug)
    );

    return {
      id: existingReleaseId || stableUuid("bandcamp-release", entry.link),
      artist_id: entry.artistId,
      title: entry.title || "Untitled release",
      slug: entry.slug || slugify(entry.title || entry.link),
      release_type: entry.releaseType || "bandcamp",
      release_date: entry.pubDate ? new Date(entry.pubDate).toISOString().slice(0, 10) : null,
      cover_image_url: entry.coverImageUrl,
      description: entry.description || null,
    };
  });
  const releaseLinkRows = entries.map((entry) => {
    const existingReleaseId = existingReleaseIdByKey.get(
      getReleaseLookupKey(entry.artistId, entry.slug)
    );

    return {
      id: stableUuid("bandcamp-release-link", entry.link),
      release_id: existingReleaseId || stableUuid("bandcamp-release", entry.link),
      platform: "bandcamp",
      url: entry.link,
      embed_url: entry.link,
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
        seededArtistCount: seededArtistIds.length,
        releaseCount: releaseRows.length,
        releaseLinkCount: releaseLinkRows.length,
        metadataSeedCount: Object.keys(getBandcampReleaseMetadataFromEnv()).length,
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

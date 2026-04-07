import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const HIDDEN_ARTIST_IDS = [];

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

function normalizeText(value) {
  return (value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function includesNormalized(haystack, needle) {
  const normalizedHaystack = normalizeText(haystack);
  const normalizedNeedle = normalizeText(needle);

  if (!normalizedHaystack || !normalizedNeedle) {
    return false;
  }

  return normalizedHaystack.includes(normalizedNeedle);
}

async function searchAppleMusic(query) {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", query);
  url.searchParams.set("media", "music");
  url.searchParams.set("entity", "album");
  url.searchParams.set("limit", "5");

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Apple search request failed: ${response.status} ${response.statusText}`);
  }

  return data.results || [];
}

function getAppleArtistAliases(artist, artistLinks) {
  const aliases = new Set();

  if (artist?.name) {
    aliases.add(artist.name);
  }

  for (const link of artistLinks) {
    const platform = (link.platform || "").toLowerCase();

    if (platform !== "apple_music" && platform !== "apple music") {
      continue;
    }

    if (link.handle) {
      aliases.add(link.handle);
    }

    const urlMatch = (link.url || "").match(/artist\/([^/]+)\//i);

    if (urlMatch?.[1]) {
      const slugAlias = urlMatch[1]
        .split("-")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");

      if (slugAlias) {
        aliases.add(slugAlias);
      }
    }
  }

  return Array.from(aliases);
}

function getReleaseTitleVariants(title) {
  const variants = new Set();
  const baseTitle = (title || "").trim();

  if (!baseTitle) {
    return [];
  }

  variants.add(baseTitle);

  const withoutParens = baseTitle.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  const parenMatches = [...baseTitle.matchAll(/\(([^)]+)\)/g)]
    .map((match) => match[1]?.trim())
    .filter(Boolean);

  if (withoutParens) {
    variants.add(withoutParens);
  }

  for (const match of parenMatches) {
    variants.add(match);
  }

  variants.add(baseTitle.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim());
  variants.add(baseTitle.replace(/\bEP\b/gi, "").replace(/\s+/g, " ").trim());

  return Array.from(variants).filter(Boolean);
}

function scoreCandidate({ artistName, releaseTitle, item }) {
  const collectionName = item?.collectionName || "";
  const itemArtistName = item?.artistName || "";
  let score = 0;

  if (includesNormalized(collectionName, releaseTitle)) {
    score += 55;
  }

  if (includesNormalized(itemArtistName, artistName)) {
    score += 30;
  }

  if (includesNormalized(`${collectionName} ${itemArtistName}`, `${artistName} ${releaseTitle}`)) {
    score += 10;
  }

  if ((item?.wrapperType || "").toLowerCase() !== "collection") {
    score -= 25;
  }

  return score;
}

async function findBestAppleMatch({ artistAliases, releaseTitle }) {
  const allCandidates = [];
  const titleVariants = getReleaseTitleVariants(releaseTitle);

  for (const artistName of artistAliases) {
    for (const titleVariant of titleVariants) {
      const results = await searchAppleMusic(`${artistName} ${titleVariant}`);

      for (const item of results) {
        allCandidates.push({
          item,
          artistName,
          score: scoreCandidate({ artistName, releaseTitle, item }),
        });
      }
    }
  }

  const best = allCandidates.sort((a, b) => b.score - a.score)[0] || null;

  if (!best || best.score < 65 || !best.item?.collectionViewUrl) {
    return {
      matched: false,
      score: best?.score || 0,
      topTitle: best?.item?.collectionName || null,
      url: null,
    };
  }

  return {
    matched: true,
    score: best.score,
    topTitle: best.item.collectionName,
    url: best.item.collectionViewUrl,
  };
}

async function main() {
  loadEnvFile();

  const supabase = createClient(
    getRequiredEnv("VITE_SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY")
  );

  const [
    { data: releases, error: releasesError },
    { data: artists, error: artistsError },
    { data: artistLinks, error: artistLinksError },
    { data: releaseLinks, error: releaseLinksError },
  ] =
    await Promise.all([
      supabase
        .from("releases")
        .select("id, artist_id, title, slug")
        .not("artist_id", "in", `(${HIDDEN_ARTIST_IDS.join(",")})`),
      supabase.from("artists").select("id, name"),
      supabase.from("artist_links").select("id, artist_id, platform, url, handle"),
      supabase.from("release_links").select("id, release_id, platform, url"),
    ]);

  if (releasesError) {
    throw releasesError;
  }

  if (artistsError) {
    throw artistsError;
  }

  if (artistLinksError) {
    throw artistLinksError;
  }

  if (releaseLinksError) {
    throw releaseLinksError;
  }

  const artistById = new Map((artists || []).map((artist) => [artist.id, artist]));
  const artistLinksByArtistId = (artistLinks || []).reduce((map, link) => {
    const current = map.get(link.artist_id) || [];
    map.set(link.artist_id, [...current, link]);
    return map;
  }, new Map());
  const appleLinkedReleaseIds = new Set(
    (releaseLinks || [])
      .filter((link) => {
        const platform = (link.platform || "").toLowerCase();
        return platform === "apple music" || platform === "apple_music";
      })
      .map((link) => link.release_id)
  );

  const targetReleases = (releases || [])
    .filter((release) => !appleLinkedReleaseIds.has(release.id))
    .filter((release) => !HIDDEN_ARTIST_IDS.includes(release.artist_id))
    .map((release) => ({
      ...release,
      artistName: artistById.get(release.artist_id)?.name || "",
      artistAliases: getAppleArtistAliases(
        artistById.get(release.artist_id),
        artistLinksByArtistId.get(release.artist_id) || []
      ),
    }))
    .filter((release) => release.artistName && release.title);

  const syncedLinks = [];
  const skipped = [];

  for (const release of targetReleases) {
    try {
      const result = await findBestAppleMatch({
        artistAliases: release.artistAliases,
        releaseTitle: release.title,
      });

      if (!result.matched || !result.url) {
        skipped.push({
          artist: release.artistName,
          release: release.title,
          slug: release.slug,
          score: result.score,
          topTitle: result.topTitle,
          reason: "No confident Apple Music match found",
        });
        continue;
      }

      syncedLinks.push({
        id: stableUuid("apple-music-release-link", result.url),
        release_id: release.id,
        platform: "apple_music",
        url: result.url,
        embed_url: result.url,
        artist: release.artistName,
        release: release.title,
        score: result.score,
      });
    } catch (error) {
      skipped.push({
        artist: release.artistName,
        release: release.title,
        slug: release.slug,
        reason: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  if (syncedLinks.length) {
    const rows = syncedLinks.map(({ artist, release, score, ...row }) => row);
    const { error: upsertError } = await supabase
      .from("release_links")
      .upsert(rows, { onConflict: "id" });

    if (upsertError) {
      throw upsertError;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedReleaseCount: targetReleases.length,
        syncedLinkCount: syncedLinks.length,
        syncedLinks: syncedLinks.map(({ artist, release, url, score }) => ({
          artist,
          release,
          url,
          score,
        })),
        skipped,
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

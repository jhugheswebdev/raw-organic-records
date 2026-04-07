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

function getYoutubeLinksFromEnv() {
  const raw = process.env.YOUTUBE_RELEASE_LINKS;

  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    throw new Error(
      `Invalid YOUTUBE_RELEASE_LINKS JSON. ${
        error instanceof Error ? error.message : ""
      }`.trim()
    );
  }
}

async function main() {
  loadEnvFile();

  const releaseLinkConfig = getYoutubeLinksFromEnv();
  const configEntries = Object.entries(releaseLinkConfig);

  if (!configEntries.length) {
    throw new Error("No YouTube release links found. Add YOUTUBE_RELEASE_LINKS.");
  }

  const supabase = createClient(
    getRequiredEnv("VITE_SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY")
  );

  const artistIds = Array.from(
    new Set(configEntries.map(([key]) => key.split(":")[0]).filter(Boolean))
  );
  const { data: releases, error: releasesError } = await supabase
    .from("releases")
    .select("id, artist_id, slug")
    .in("artist_id", artistIds);

  if (releasesError) {
    throw releasesError;
  }

  const releaseIdByKey = new Map(
    (releases || []).map((release) => [`${release.artist_id}:${release.slug}`, release.id])
  );

  const failedLinks = [];
  const releaseLinkRows = [];

  for (const [key, url] of configEntries) {
    const releaseId = releaseIdByKey.get(key);

    if (!releaseId) {
      failedLinks.push({
        key,
        url,
        error: "Matching release not found for artist_id:slug",
      });
      continue;
    }

    releaseLinkRows.push({
      id: stableUuid("youtube-release-link", url),
      release_id: releaseId,
      platform: "youtube",
      url,
      embed_url: url,
    });
  }

  if (releaseLinkRows.length) {
    const { error: releaseLinksError } = await supabase
      .from("release_links")
      .upsert(releaseLinkRows, { onConflict: "id" });

    if (releaseLinksError) {
      throw releaseLinksError;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        configuredLinkCount: configEntries.length,
        syncedLinkCount: releaseLinkRows.length,
        failedLinks,
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

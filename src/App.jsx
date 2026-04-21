import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";
import { Analytics } from "@vercel/analytics/react";


const pages = [
  { id: "home", label: "Home" },
  { id: "artists", label: "Artists" },
  { id: "music", label: "Music" },
  { id: "blog", label: "Blog" },
];
const SOCIAL_ENABLED = false;

const HIDDEN_ARTIST_IDS = [];
const BLACK_TOKYO_ARTIST_ID = "8a1ef2d3-ac3c-4b91-9520-a20427c0d1a3";
const HIDDEN_RELEASE_SLUGS = new Set([
  "no-music-for-old-niggas",
  "mr-slugsworth",
]);

function shouldHideRelease(release) {
  if (!release) {
    return false;
  }

  if (HIDDEN_ARTIST_IDS.includes(release.artist_id)) {
    return true;
  }

  if (release.artist_id !== BLACK_TOKYO_ARTIST_ID) {
    return false;
  }

  if (HIDDEN_RELEASE_SLUGS.has(release.slug)) {
    return true;
  }

  const releaseText = [release.title, release.slug, release.description]
    .filter(Boolean)
    .join(" ");

  return /\bab(?:-| )?digi(?:tek)?\b/i.test(releaseText);
}

function getInitialRoute() {
  const hash = window.location.hash.replace(/^#\/?/, "");

  if (hash.startsWith("artist/")) {
    const artistSlug = hash.replace("artist/", "");
    return { page: "artist-detail", artistSlug };
  }

  if (hash.startsWith("release/")) {
    const releaseSlug = hash.replace("release/", "");
    return { page: "release-detail", releaseSlug };
  }

  if (hash.startsWith("blog/")) {
    const blogSlug = hash.replace("blog/", "");
    return { page: "blog-detail", blogSlug };
  }

  if (SOCIAL_ENABLED && hash.startsWith("social/")) {
    const socialSlug = hash.replace("social/", "");
    return { page: "social-detail", socialSlug };
  }

  if (pages.some((page) => page.id === hash)) {
    return { page: hash, artistId: null };
  }

  return { page: "home", artistSlug: null, releaseSlug: null, blogSlug: null, socialSlug: null };
}

function setRouteHash(page, slug = null) {
  if (page === "artist-detail" && slug) {
    window.location.hash = `/artist/${slug}`;
    return;
  }

  if (page === "release-detail" && slug) {
    window.location.hash = `/release/${slug}`;
    return;
  }

  if (page === "blog-detail" && slug) {
    window.location.hash = `/blog/${slug}`;
    return;
  }

  if (SOCIAL_ENABLED && page === "social-detail" && slug) {
    window.location.hash = `/social/${slug}`;
    return;
  }

  window.location.hash = page === "home" ? "/" : `/${page}`;
}

function getPlatformSource(platform) {
  const value = (platform || "").toLowerCase();

  if (value === "instagram") return "IG";
  if (value === "facebook") return "FB";
  if (value === "tiktok") return "TT";
  if (value === "soundcloud") return "SC";
  if (value === "spotify") return "SP";
  if (value === "bandcamp") return "BC";
  if (value === "x" || value === "twitter") return "X";

  return (platform || "--").slice(0, 2).toUpperCase();
}

function formatPublishedAt(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function toSortableTime(value) {
  if (!value) return 0;

  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function normalizeSocialPost(post, artistNameById) {
  const platform = post.platform || "Unknown";
  const publishedAtValue = post.posted_at || post.created_at;
  const body =
    post.content ||
    post.caption ||
    post.description ||
    post.content_text ||
    "No post copy available yet.";
  const title =
    post.title ||
    post.caption ||
    post.content_text?.slice(0, 80) ||
    `${platform} update`;

  return {
    id: post.id,
    slug: post.slug || post.external_post_id || String(post.id),
    artistId: post.artist_id,
    artist: {
      name: artistNameById.get(post.artist_id) || "Unknown artist",
    },
    platform,
    source: post.source || getPlatformSource(platform),
    publishedAt: formatPublishedAt(publishedAtValue),
    publishedAtValue,
    title,
    body,
    type: post.post_type || post.type || post.media_type || "post",
    postUrl: post.post_url || null,
  };
}

function formatPlatformLabel(value) {
  if (!value) return "Link";

  const normalized = value.toLowerCase();

  if (normalized === "youtube") {
    return "YouTube";
  }

  if (normalized === "youtube_music" || normalized === "youtube music") {
    return "YouTube Music";
  }

  return value
    .split(/[_\s-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getArtistLinkBucket(platform, url) {
  const value = (platform || "").toLowerCase();
  const normalizedUrl = (url || "").toLowerCase();

  if (
    [
      "spotify",
      "apple_music",
      "apple music",
      "bandcamp",
      "soundcloud",
      "youtube_music",
      "youtube music",
      "audiomack",
      "tidal",
    ].includes(value)
  ) {
    return value === "bandcamp" && (normalizedUrl.includes("/merch") || normalizedUrl.includes("/store"))
      ? "Support"
      : "Listen";
  }

  if (
    ["instagram", "tiktok", "x", "twitter", "facebook", "threads", "youtube"].includes(value)
  ) {
    return "Follow";
  }

  if (
    ["patreon", "ko-fi", "kofi", "merch", "store", "shop", "website"].includes(value) ||
    normalizedUrl.includes("/shop") ||
    normalizedUrl.includes("/store") ||
    normalizedUrl.includes("/merch")
  ) {
    return "Support";
  }

  return "More";
}

function getArtistInitials(artist) {
  if (!artist?.name) {
    return "--";
  }

  return artist.name
    .split(" ")
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function getArtistPhotoUrl(artist) {
  return artist?.photo_url || artist?.profile_image_url || artist?.hero_image_url || null;
}

function getArtistLinkDisplayLabel(link) {
  if (link.label) {
    return link.label;
  }

  const baseLabel = link.handle || formatPlatformLabel(link.platform);
  const platform = (link.platform || "").toLowerCase();

  if (platform === "apple_music" || platform === "apple music") {
    const regionMatch = (link.url || "").match(/music\.apple\.com\/([a-z]{2})\//i);

    if (regionMatch?.[1]) {
      return `${baseLabel} (${regionMatch[1].toUpperCase()})`;
    }
  }

  return baseLabel;
}

function normalizeReleaseLink(link) {
  return {
    id: link.id,
    releaseId: link.release_id,
    platform: formatPlatformLabel(link.platform),
    url: link.url || link.embed_url || link.link_url || "#",
    label: link.label || formatPlatformLabel(link.platform),
  };
}

function parseDurationToMs(value) {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1000 ? value : value * 1000;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return numeric > 1000 ? numeric : numeric * 1000;
  }

  const clockParts = trimmed.split(":").map((part) => Number(part));

  if (clockParts.every((part) => Number.isFinite(part))) {
    if (clockParts.length === 2) {
      const [minutes, seconds] = clockParts;
      return (minutes * 60 + seconds) * 1000;
    }

    if (clockParts.length === 3) {
      const [hours, minutes, seconds] = clockParts;
      return (hours * 3600 + minutes * 60 + seconds) * 1000;
    }
  }

  const isoMatch = trimmed.match(
    /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i
  );

  if (isoMatch) {
    const hours = Number(isoMatch[1] || 0);
    const minutes = Number(isoMatch[2] || 0);
    const seconds = Number(isoMatch[3] || 0);
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }

  return null;
}

function getReleaseDurationMs(release) {
  const candidateValues = [
    release.duration_ms,
    release.duration,
    release.duration_seconds,
    release.length,
    release.runtime,
    release.track_duration_ms,
    release.track_duration,
  ];

  for (const value of candidateValues) {
    const parsed = parseDurationToMs(value);

    if (parsed != null) {
      return parsed;
    }
  }

  for (const link of release.links || []) {
    const linkValues = [
      link.duration_ms,
      link.duration,
      link.duration_seconds,
      link.length,
      link.runtime,
    ];

    for (const value of linkValues) {
      const parsed = parseDurationToMs(value);

      if (parsed != null) {
        return parsed;
      }
    }
  }

  return null;
}

function hasSoundCloudLink(release) {
  return (release.links || []).some((link) => (link.platform || "").toLowerCase() === "soundcloud");
}

function getReleaseTypeLabel(release) {
  if (hasSoundCloudLink(release)) {
    const durationMs = getReleaseDurationMs(release);

    if (durationMs != null && durationMs > 10 * 60 * 1000) {
      return "DJ Mix";
    }
  }

  return release.release_type || release.format || "Release";
}

function getReleaseLinksWithArtistFallback(release, normalizedReleaseLinks, artistLinksByArtistId) {
  return normalizedReleaseLinks.filter((link) => link.releaseId === release.id);
}

function getEmbedUrl(link) {
  const platform = (link.platform || "").toLowerCase();
  const url = link.url || "";

  if (!url) {
    return null;
  }

  if (platform === "spotify") {
    if (url.includes("open.spotify.com/embed/")) {
      return url;
    }

    const match = url.match(/open\.spotify\.com\/(album|track|playlist|artist)\/([A-Za-z0-9]+)/i);
    if (match) {
      return `https://open.spotify.com/embed/${match[1].toLowerCase()}/${match[2]}`;
    }
  }

  if (platform === "apple music" || platform === "apple_music") {
    if (url.includes("embed.music.apple.com/")) {
      return url;
    }

    const normalizedAppleUrl = url.replace("music.apple.com/", "embed.music.apple.com/");

    if (normalizedAppleUrl.includes("embed.music.apple.com/")) {
      return normalizedAppleUrl.includes("?")
        ? `${normalizedAppleUrl}&app=music`
        : `${normalizedAppleUrl}?app=music`;
    }
  }

  if (platform === "youtube" || platform === "youtube music" || platform === "youtube_music") {
    const watchMatch = url.match(/[?&]v=([^&]+)/i);
    const shortMatch = url.match(/youtu\.be\/([^?&/]+)/i);
    const playlistMatch = url.match(/[?&]list=([^&]+)/i);
    const embedId = watchMatch?.[1] || shortMatch?.[1];

    if (embedId) {
      return `https://www.youtube.com/embed/${embedId}`;
    }

    if (playlistMatch?.[1]) {
      return `https://www.youtube.com/embed/videoseries?list=${playlistMatch[1]}`;
    }
  }

  if (platform === "soundcloud") {
    if (url.includes("w.soundcloud.com/player/")) {
      return url;
    }

    return `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&color=%237a1e1e&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true`;
  }

  if (platform === "bandcamp") {
    if (url.includes("/EmbeddedPlayer/")) {
      return url;
    }
  }

  return null;
}

function formatBlogDate(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function PlatformMark({ platform }) {
  const value = (platform || "").toLowerCase();

  if (value === "spotify") {
    return (
      <span aria-hidden="true" className="platform-mark platform-mark-spotify">
        <svg fill="none" viewBox="0 0 24 24">
          <circle cx="12" cy="12" fill="currentColor" r="12" />
          <path
            d="M17.45 15.86a.84.84 0 0 1-1.16.28c-3.17-1.94-7.17-2.38-11.88-1.31a.84.84 0 1 1-.37-1.64c5.15-1.17 9.57-.67 13.13 1.5a.84.84 0 0 1 .28 1.17Zm1.65-3.67a1.05 1.05 0 0 1-1.44.35c-3.63-2.23-9.17-2.88-13.47-1.58a1.05 1.05 0 0 1-.61-2.01c4.91-1.49 11.03-.77 15.18 1.78.5.31.66.95.34 1.46Zm.14-3.83C14.9 5.8 7.77 5.56 3.64 6.84a1.26 1.26 0 0 1-.74-2.4c4.75-1.45 12.65-1.17 17.66 1.83a1.26 1.26 0 0 1-1.3 2.09Z"
            fill="#f8f6ef"
          />
        </svg>
      </span>
    );
  }

  if (value === "bandcamp") {
    return (
      <span aria-hidden="true" className="platform-mark platform-mark-bandcamp">
        <svg fill="none" viewBox="0 0 24 24">
          <path d="M7.2 5.5H21L16.8 18.5H3L7.2 5.5Z" fill="currentColor" />
        </svg>
      </span>
    );
  }

  if (value === "soundcloud") {
    return (
      <span aria-hidden="true" className="platform-mark platform-mark-soundcloud">
        <svg fill="none" viewBox="0 0 24 24">
          <path
            d="M9.78 9.05a3.5 3.5 0 0 1 6.59 1.4 2.7 2.7 0 0 1 .8-.12A3.33 3.33 0 0 1 20.5 13.66 3.34 3.34 0 0 1 17.17 17H7.2a2.7 2.7 0 0 1-2.7-2.7c0-1.3.91-2.4 2.13-2.64a3.51 3.51 0 0 1 3.15-2.61Z"
            fill="currentColor"
          />
          <path
            d="M3.2 10.4h1v6.4h-1v-6.4Zm-1.8 1.7h1v4.7h-1v-4.7Zm5.35-4.15h1v8.85h-1V7.95Zm1.78-.9h1v9.75h-1V7.05Z"
            fill="currentColor"
          />
        </svg>
      </span>
    );
  }

  if (value === "apple music" || value === "apple_music") {
    return (
      <span aria-hidden="true" className="platform-mark platform-mark-apple-music">
        <svg fill="none" viewBox="0 0 24 24">
          <path
            d="M16.2 4.5a2 2 0 0 1 1.55-.08c.17.08.25.26.25.46v10.15a2.86 2.86 0 0 1-2 2.76l-2.26.75a3.35 3.35 0 0 1-1.03.17c-1.5 0-2.71-.93-2.71-2.07 0-.95.84-1.77 2.04-1.99l2.97-.55V7.7l-5.46 1.44v8.22a2.86 2.86 0 0 1-2 2.76l-1.77.59a3.35 3.35 0 0 1-1.03.17c-1.5 0-2.71-.93-2.71-2.07 0-.95.84-1.77 2.04-1.99l2.48-.46V7.67c0-.41.27-.77.66-.88l8.97-2.29Z"
            fill="currentColor"
          />
        </svg>
      </span>
    );
  }

  if (value === "youtube music" || value === "youtube_music") {
    return (
      <span aria-hidden="true" className="platform-mark platform-mark-youtube-music">
        <svg fill="none" viewBox="0 0 24 24">
          <circle cx="12" cy="12" fill="currentColor" r="12" />
          <circle cx="12" cy="12" fill="none" r="6.6" stroke="#f8f6ef" strokeWidth="1.6" />
          <path d="M10 8.9 15.1 12 10 15.1V8.9Z" fill="#f8f6ef" />
        </svg>
      </span>
    );
  }

  if (value === "youtube") {
    return (
      <span aria-hidden="true" className="platform-mark platform-mark-youtube">
        <svg fill="none" viewBox="0 0 24 24">
          <rect fill="currentColor" height="14" rx="4.2" width="20" x="2" y="5" />
          <path d="m10 9 5.6 3-5.6 3V9Z" fill="#f8f6ef" />
        </svg>
      </span>
    );
  }

  return null;
}

function normalizeBlogPost(post, relatedArtists = []) {
  const relatedArtistNames = relatedArtists.map((artist) => artist.name);

  return {
    id: post.id,
    slug: post.slug || String(post.id),
    category: post.category || "Journal",
    title: post.title || "Untitled post",
    excerpt: post.excerpt || post.summary || post.content || "No excerpt available yet.",
    body: post.content || post.body || post.excerpt || post.summary || "No post content yet.",
    date: formatBlogDate(post.published_at || post.created_at),
    sortableTime: toSortableTime(post.published_at || post.created_at),
    relatedArtists: relatedArtistNames,
    relatedArtistIds: relatedArtists.map((artist) => artist.id),
    relatedArtistSlugsByName: relatedArtists.reduce((map, artist) => {
      if (artist.slug) {
        map[artist.name] = artist.slug;
      }

      return map;
    }, {}),
  };
}

function FeedItem({ item }) {
  return (
    <article className="feed-item">
      <div className="feed-source">{item.source}</div>
      <div className="feed-content">
        <div className="feed-meta">
          <span className="feed-artist">{item.artist?.name}</span>
          <span className="feed-platform">{item.platform}</span>
          <span className="feed-time">{item.publishedAt}</span>
        </div>
        <p className="feed-text">
          {item.title}. {item.body}
        </p>
        <span className="feed-pill">{item.type}</span>
      </div>
    </article>
  );
}

function SocialPostDetail({ onBack, onOpenArtist, post }) {
  if (!post) {
    return (
      <main className="page active">
        <button className="back-btn" onClick={onBack} type="button">
          Back
        </button>
        <div className="empty-state">Social post not found.</div>
      </main>
    );
  }

  return (
    <main className="page active social-detail-page">
      <button className="back-btn" onClick={onBack} type="button">
        Back
      </button>
      <section className="social-detail-hero">
        <div className="feed-source social-detail-source">{post.source}</div>
        <div className="social-detail-copy">
          <p className="blog-tag">{post.platform}</p>
          <h1 className="social-detail-title">{post.title}</h1>
          <div className="social-detail-meta">
            <span>{post.publishedAt}</span>
            <span>{post.type}</span>
          </div>
          <p className="social-detail-body">{post.body}</p>
          {post.artistSlug ? (
            <div className="release-link-list">
              <button
                className="release-link-chip release-link-chip-button"
                onClick={() => onOpenArtist(post.artistSlug)}
                type="button"
              >
                {post.artist?.name}
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function ArtistCard({ artist, artistLinks = [], onOpen }) {
  const initials = getArtistInitials(artist);
  const artistRouteValue = artist.slug || artist.id;
  const photoUrl = getArtistPhotoUrl(artist);
  const platformTags = Array.from(
    new Set(
      artistLinks
        .map((link) => formatPlatformLabel(link.platform))
        .filter(Boolean)
    )
  );

  return (
    <article className="artist-card" onClick={() => onOpen(artistRouteValue)}>
      <div className="artist-card-media">
        {photoUrl ? (
          <img alt={artist.name} className="artist-photo" src={photoUrl} />
        ) : (
          <div className="artist-photo-placeholder">{initials}</div>
        )}
      </div>
      <div className="artist-card-copy">
        <h3 className="artist-name">{artist.name}</h3>
        <p className="artist-genre">{artist.genre || "Unknown genre"}</p>
        {platformTags.length ? (
          <div className="artist-platforms">
            {platformTags.map((platform) => (
              <span key={platform} className="platform-tag">
                {platform}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function MusicCard({ release }) {
  const artistName = release.artistName || release.artist?.name || release.artist_id || "Unknown artist";
  const releaseType = getReleaseTypeLabel(release);
  const releaseDate = release.release_date
    ? new Date(release.release_date).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;
  const description = release.description || release.blurb || "";

  return (
    <article className="music-card">
      <div className="music-art">
        {release.cover_image_url ? (
          <img alt={release.title} className="music-cover-image" src={release.cover_image_url} />
        ) : (
          releaseType
        )}
      </div>
      <h3 className="music-title">{release.title}</h3>
      <p className="music-artist">{artistName}</p>
      <p className="music-source">
        {[releaseType, releaseDate].filter(Boolean).join(" / ")}
      </p>
      {description ? <p className="music-description">{description}</p> : null}
      {release.links?.length ? (
        <div className="release-link-list">
          {release.links.map((link) => (
            <a
              key={link.id}
              className="release-link-chip"
              href={link.url}
              rel="noreferrer"
              target="_blank"
            >
              <PlatformMark platform={link.platform} />
              {link.platform}
            </a>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ArtistMusicCard({ isLead = false, release }) {
  const releaseType = getReleaseTypeLabel(release);
  const releaseDate = release.release_date
    ? new Date(release.release_date).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <article className={`artist-music-card ${isLead ? "artist-music-card-lead" : ""}`}>
      <div className="artist-music-art">
        {release.cover_image_url ? (
          <img alt={release.title} className="music-cover-image" src={release.cover_image_url} />
        ) : (
          releaseType
        )}
      </div>
      <div className="artist-music-copy">
        <div className="artist-music-meta-row">
          <p className="blog-tag">{releaseType}</p>
          {isLead ? <span className="artist-music-lead-pill">Latest</span> : null}
        </div>
        <h3 className="artist-music-title">{release.title}</h3>
        <p className="music-source">{releaseDate || "Date TBD"}</p>
      </div>
    </article>
  );
}

function ReleaseFeature({ release }) {
  return (
    <article className="release-feature">
      <p className="blog-tag">
        {release.format} / {release.year}
      </p>
      <h3 className="blog-title">{release.title}</h3>
      <p className="music-artist">{release.artist?.name}</p>
      <p className="blog-excerpt">{release.blurb}</p>
      <p className="music-source">{release.platforms.join(" / ")}</p>
    </article>
  );
}

function BlogCard({ post }) {
  const relatedArtistLine = post.relatedArtists.length ? post.relatedArtists.join(" / ") : null;

  return (
    <article className="blog-item">
      <div>
        <p className="blog-tag">{post.category}</p>
        <h3 className="blog-title">{post.title}</h3>
        <p className="blog-excerpt">{post.excerpt}</p>
        {relatedArtistLine ? <p className="music-artist">{relatedArtistLine}</p> : null}
        <p className="blog-byline">Raw Organic Records / {post.date}</p>
      </div>
      <div className="blog-img">Journal</div>
    </article>
  );
}

function ArtistJournalCard({ post }) {
  return (
    <article className="artist-journal-card">
      <p className="blog-tag">{post.category}</p>
      <h3 className="blog-title">{post.title}</h3>
      <p className="blog-excerpt">{post.excerpt}</p>
      {post.relatedArtists.length ? (
        <p className="music-artist">{post.relatedArtists.join(" / ")}</p>
      ) : null}
      <p className="blog-byline">Raw Organic Records / {post.date}</p>
    </article>
  );
}

function BlogDetail({ onBack, onOpenArtist, post }) {
  if (!post) {
    return (
      <main className="page active">
        <button className="back-btn" onClick={onBack} type="button">
          Back
        </button>
        <div className="empty-state">Blog post not found.</div>
      </main>
    );
  }

  const paragraphs = post.body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return (
    <main className="page active blog-detail-page">
      <button className="back-btn" onClick={onBack} type="button">
        Back
      </button>
      <section className="blog-detail-hero">
        <p className="blog-tag">{post.category}</p>
        <h1 className="blog-detail-title">{post.title}</h1>
        <p className="blog-byline">Raw Organic Records / {post.date}</p>
        {post.relatedArtists.length ? (
          <div className="release-link-list">
            {post.relatedArtists.map((artistName) => {
              const artistSlug = post.relatedArtistSlugsByName[artistName];

              return artistSlug ? (
                <button
                  key={artistName}
                  className="release-link-chip release-link-chip-button"
                  onClick={() => onOpenArtist(artistSlug)}
                  type="button"
                >
                  {artistName}
                </button>
              ) : (
                <span key={artistName} className="release-link-chip">
                  {artistName}
                </span>
              );
            })}
          </div>
        ) : null}
      </section>
      <section className="blog-detail-body">
        <div className="blog-detail-copy">
          {(paragraphs.length ? paragraphs : [post.excerpt]).map((paragraph, index) => (
            <p key={`${post.id}-${index}`}>{paragraph}</p>
          ))}
        </div>
      </section>
    </main>
  );
}

function HomeEntryCard({ entry }) {
  return (
    <article className="home-entry-card">
      <div className="home-entry-media">
        {entry.imageUrl ? (
          <img alt={entry.title} className="music-cover-image" src={entry.imageUrl} />
        ) : (
          <span>{entry.mediaLabel}</span>
        )}
      </div>
      <div className="home-entry-copy">
        <p className="blog-tag">{entry.kicker}</p>
        <h2 className="home-entry-title">{entry.title}</h2>
        <p className="home-entry-meta">
          {[entry.artistName, entry.date].filter(Boolean).join(" / ")}
        </p>
        <p className="blog-excerpt">{entry.excerpt}</p>
        {entry.links?.length ? (
          <div className="release-link-list">
            {entry.links.map((link) => (
              <a
                key={link.id}
                className="release-link-chip"
                href={link.url}
                rel="noreferrer"
                target="_blank"
              >
                <PlatformMark platform={link.platform} />
                {link.platform}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ReleaseDetail({ onBack, onOpenArtist, release }) {
  if (!release) {
    return (
      <main className="page active">
        <button className="back-btn" onClick={onBack} type="button">
          Back
        </button>
        <div className="empty-state">Release not found.</div>
      </main>
    );
  }

  const releaseType = getReleaseTypeLabel(release);
  const releaseDate = release.release_date
    ? new Date(release.release_date).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;
  const embeddableLinks = (release.links || [])
    .map((link) => ({
      ...link,
      embedUrl: getEmbedUrl(link),
    }))
    .filter((link) => link.embedUrl);
  const artistMetaParts = [releaseType, releaseDate].filter(Boolean);

  return (
    <main className="page active release-detail-page">
      <button className="back-btn" onClick={onBack} type="button">
        Back
      </button>
      <section className="release-detail-hero">
        <div className="release-detail-art">
          {release.cover_image_url ? (
            <img alt={release.title} className="music-cover-image" src={release.cover_image_url} />
          ) : (
            releaseType
          )}
        </div>
        <div className="release-detail-copy">
          <p className="blog-tag">Release</p>
          <h1 className="artist-detail-name">{release.title}</h1>
          <p className="artist-detail-genre">
            {release.artistSlug ? (
              <button
                className="inline-link-button"
                onClick={() => onOpenArtist(release.artistSlug)}
                type="button"
              >
                {release.artistName}
              </button>
            ) : (
              release.artistName
            )}
            {artistMetaParts.length ? ` / ${artistMetaParts.join(" / ")}` : ""}
          </p>
          <p className="release-detail-description">
            {release.description || "No release description yet."}
          </p>
          {release.links?.length ? (
            <div className="release-link-list">
              {release.links.map((link) => (
              <a
                key={link.id}
                className="release-link-chip"
                href={link.url}
                rel="noreferrer"
                target="_blank"
              >
                <PlatformMark platform={link.platform} />
                {link.platform}
              </a>
            ))}
          </div>
          ) : (
            <div className="empty-state inline-empty-state">No platform links yet.</div>
          )}
        </div>
      </section>

      {embeddableLinks.length ? (
        <section className="release-embed-section">
          <SectionHeader title="Listen / Watch" count={`${embeddableLinks.length} embeds`} />
          <div className="release-embed-list">
            {embeddableLinks.map((link) => (
              <article key={link.id} className="release-embed-card">
                <p className="blog-tag">{link.platform}</p>
                <div className="release-embed-frame">
                  <iframe
                    allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                    className="embed-iframe"
                    loading="lazy"
                    src={link.embedUrl}
                    title={`${release.title} on ${link.platform}`}
                  />
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

function SectionHeader({ title, count }) {
  return (
    <div className="section-header">
      <p className="section-title">{title}</p>
      {count ? <p className="section-count">{count}</p> : null}
    </div>
  );
}

function SocialPlatformSection({ items, onOpenPost, platform }) {
  const connectedArtists = new Set(items.map((item) => item.artistId)).size;

  return (
    <section>
      <div className="section-header social-platform-header">
        <p className="section-title">{platform}</p>
        <p className="section-count">
          {items.length} posts / {connectedArtists} artists
        </p>
      </div>
      <div className="feed">
        {items.length ? (
          items.map((item) => (
            <button
              key={item.id}
              className="card-button"
              onClick={() => onOpenPost(item.slug)}
              type="button"
            >
              <FeedItem item={item} />
            </button>
          ))
        ) : (
          <div className="empty-state">No posts yet.</div>
        )}
      </div>
    </section>
  );
}

function ArtistEmbedSection({ artistLinks }) {
  const embeddableLinks = artistLinks
    .map((link) => ({
      ...link,
      embedUrl: getEmbedUrl({
        platform: formatPlatformLabel(link.platform),
        url: link.url,
      }),
      platformLabel: formatPlatformLabel(link.platform),
    }))
    .filter((link) => link.embedUrl);

  if (!embeddableLinks.length) {
    return null;
  }

  return (
    <section className="artist-embed-section">
      <p className="about-label">Featured embeds</p>
      <div className="release-embed-list">
        {embeddableLinks.map((link) => (
          <article key={link.id} className="release-embed-card">
            <p className="blog-tag">{link.platformLabel}</p>
            <div className="release-embed-frame">
              <iframe
                allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                className="embed-iframe"
                loading="lazy"
                src={link.embedUrl}
                title={`${link.platformLabel} embed`}
              />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ArtistLinkBuckets({ artistLinks }) {
  const bucketOrder = ["Listen", "Follow", "Support", "More"];
  const groupedLinks = artistLinks.reduce((map, link) => {
    const bucket = getArtistLinkBucket(link.platform, link.url);
    const currentLinks = map.get(bucket) || [];
    map.set(bucket, [...currentLinks, link]);
    return map;
  }, new Map());

  const visibleBuckets = bucketOrder
    .map((bucket) => ({
      bucket,
      links: groupedLinks.get(bucket) || [],
    }))
    .filter((group) => group.links.length);

  if (!visibleBuckets.length) {
    return <div className="empty-state inline-empty-state">No artist links yet.</div>;
  }

  return (
    <div className="artist-link-groups">
      {visibleBuckets.map((group) => (
        <section key={group.bucket} className="artist-link-group">
          <p className="about-label">{group.bucket}</p>
          <div className="account-list">
            {group.links.map((link) => (
              <a
                key={link.id}
                className="account-row account-link-row"
                href={link.url}
                rel="noreferrer"
                target="_blank"
              >
                <span className="account-platform">
                  <PlatformMark platform={link.platform} />
                  {formatPlatformLabel(link.platform)}
                </span>
                <strong>{getArtistLinkDisplayLabel(link)}</strong>
              </a>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ArtistDetail({
  artist,
  artistLinks,
  artistJournalPosts,
  artistReleases,
  artistId,
  activeTab,
  onBack,
  onOpenBlogPost,
  onOpenRelease,
  onTabChange,
}) {
  const artistPlatformLinks = useMemo(
    () => artistLinks.filter((link) => link.artist_id === artistId),
    [artistLinks, artistId]
  );
  const artistGenre = typeof artist?.genre === "string" ? artist.genre.trim() : "";
  const artistBio = artist?.bio || artist?.short_bio || "No artist bio yet.";
  const artistLocation = typeof artist?.location === "string" ? artist.location.trim() : "";
  const latestJournalPosts = artistJournalPosts.slice(0, 3);
  const latestReleaseYear = artistReleases[0]?.release_date
    ? new Date(artistReleases[0].release_date).getFullYear()
    : null;
  const artistMetaLine = [artistGenre, artistLocation].filter(Boolean).join(" / ");
  const visibleStats = [
    { key: "releases", label: "Releases", value: artistReleases.length },
    artistPlatformLinks.length
      ? { key: "platform-links", label: "Platform links", value: artistPlatformLinks.length }
      : null,
  ].filter(Boolean);

  if (!artist) {
    return (
      <main className="page active">
        <button className="back-btn" onClick={onBack} type="button">
          Back to artists
        </button>
        <div className="empty-state">Artist not found.</div>
      </main>
    );
  }

  return (
    <main className="page active artist-detail">
      <button className="back-btn" onClick={onBack} type="button">
        Back to artists
      </button>

      <section className="artist-detail-hero">
        <div className="artist-detail-meta">
          <h1 className="artist-detail-name">{artist.name}</h1>
          {artistMetaLine ? <p className="artist-detail-genre">{artistMetaLine}</p> : null}
          <div className="artist-stats">
            {visibleStats.map((stat) => (
              <div key={stat.key}>
                <div className="artist-stat-num">{stat.value}</div>
                <div className="artist-stat-label">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="tabs">
        {["music", "about"].map((tab) => (
          <button
            key={tab}
            className={`tab ${activeTab === tab ? "active" : ""}`}
            onClick={() => onTabChange(tab)}
            type="button"
          >
            {tab}
          </button>
        ))}
      </div>

        {activeTab === "music" ? (
        <section className="artist-music-panel">
          <div className="section-header artist-detail-section-header">
            <p className="section-title">Discography</p>
            <p className="section-count">
              {artistReleases.length} releases{latestReleaseYear ? ` / latest ${latestReleaseYear}` : ""}
            </p>
          </div>
          <div className="artist-music-grid">
            {artistReleases.length ? (
              artistReleases.map((release, index) =>
                release.slug ? (
                  <button
                    key={release.id}
                    className="card-button artist-music-button"
                    onClick={() => onOpenRelease(release.slug)}
                    type="button"
                  >
                    <ArtistMusicCard isLead={index === 0} release={release} />
                  </button>
                ) : (
                  <ArtistMusicCard isLead={index === 0} key={release.id} release={release} />
                )
              )
            ) : (
            <div className="empty-state">No releases yet.</div>
          )}
          </div>
        </section>
      ) : null}

      {activeTab === "about" ? (
        <div className="about-panel">
          <div className="about-grid">
            <div>
              <p className="about-label">Overview</p>
              <p>{artistBio}</p>
            </div>
            <div>
              <ArtistLinkBuckets artistLinks={artistPlatformLinks} />
            </div>
          </div>

          <div className="artist-journal-section">
            <div className="section-header artist-detail-section-header">
              <p className="section-title">Related Journal</p>
              <p className="section-count">{latestJournalPosts.length} linked posts</p>
            </div>
            {latestJournalPosts.length ? (
              <div className="artist-journal-list">
                {latestJournalPosts.map((post) => (
                  <button
                    key={post.id}
                    className="card-button"
                    onClick={() => onOpenBlogPost(post.slug)}
                    type="button"
                  >
                    <ArtistJournalCard post={post} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-state inline-empty-state">No related journal posts yet.</div>
            )}
          </div>

          <ArtistEmbedSection artistLinks={artistPlatformLinks} />
        </div>
      ) : null}
    </main>
  );
}

function LoadingState() {
  return <div className="empty-state">Loading label archive...</div>;
}

function ErrorState() {
  return <div className="empty-state">Could not load label content.</div>;
}

export default function App() {
  const [route, setRoute] = useState(() => getInitialRoute());
  const [activeTab, setActiveTab] = useState("music");
  const [detailBackTarget, setDetailBackTarget] = useState(null);
  const [artists, setArtists] = useState([]);
  const [releases, setReleases] = useState([]);
  const [releaseLinks, setReleaseLinks] = useState([]);
  const [socialPosts, setSocialPosts] = useState([]);
  const [artistLinks, setArtistLinks] = useState([]);
  const [blogPosts, setBlogPosts] = useState([]);
  const [blogPostArtists, setBlogPostArtists] = useState([]);

useEffect(() => {
  const getArtists = async () => {
    const { data, error } = await supabase.from('artists').select('*');

    if (!error && data) {
      setArtists(data);
    }
  };

  getArtists();
}, []);

useEffect(() => {
  const getReleases = async () => {
    const { data, error } = await supabase
      .from("releases")
      .select("*")
      .order("release_date", { ascending: false, nullsFirst: false });

    if (!error && data) {
      setReleases(data);
    }
  };

  getReleases();
}, []);

useEffect(() => {
  const getSocialPosts = async () => {
    const { data, error } = await supabase
      .from("social_posts")
      .select("*")
      .order("posted_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (!error && data) {
      setSocialPosts(data);
    }
  };

  getSocialPosts();
}, []);

useEffect(() => {
  const getReleaseLinks = async () => {
    const { data, error } = await supabase.from("release_links").select("*");

    if (!error && data) {
      setReleaseLinks(data);
    }
  };

  getReleaseLinks();
}, []);

useEffect(() => {
  const getArtistLinks = async () => {
    const { data, error } = await supabase.from("artist_links").select("*");

    if (!error && data) {
      setArtistLinks(data);
    }
  };

  getArtistLinks();
}, []);

useEffect(() => {
  const getBlogPosts = async () => {
    const { data, error } = await supabase
      .from("blog_posts")
      .select("*")
      .order("published_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (!error && data) {
      setBlogPosts(data);
    }
  };

  getBlogPosts();
}, []);

useEffect(() => {
  const getBlogPostArtists = async () => {
    const { data, error } = await supabase.from("blog_post_artists").select("*");

    if (!error && data) {
      setBlogPostArtists(data);
    }
  };

  getBlogPostArtists();
}, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [route]);

  useEffect(() => {
    const onHashChange = () => {
      const nextRoute = getInitialRoute();
      setRoute(nextRoute);
      setActiveTab(nextRoute.page === "artist-detail" ? activeTab : "music");
    };

    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [activeTab]);

  const syncRoute = (nextRoute) => {
    setRoute(nextRoute);

    if (nextRoute.page === "artist-detail") {
      setRouteHash("artist-detail", nextRoute.artistSlug);
      return;
    }

    if (nextRoute.page === "release-detail") {
      setRouteHash("release-detail", nextRoute.releaseSlug);
      return;
    }

    if (nextRoute.page === "blog-detail") {
      setRouteHash("blog-detail", nextRoute.blogSlug);
      return;
    }

    if (nextRoute.page === "social-detail") {
      setRouteHash("social-detail", nextRoute.socialSlug);
      return;
    }

    setRouteHash(nextRoute.page);
  };

  const buildBackTarget = (sourceRoute = route, sourceTab = activeTab) => ({
    route: { ...sourceRoute },
    activeTab: sourceRoute.page === "artist-detail" ? sourceTab : "music",
  });

  const goToPage = (page) => {
    setDetailBackTarget(null);
    setActiveTab("music");
    syncRoute({ page, artistSlug: null, releaseSlug: null, blogSlug: null, socialSlug: null });
  };

  const openArtist = (artistSlug) => {
    setDetailBackTarget(null);
    setActiveTab("music");
    syncRoute({ page: "artist-detail", artistSlug, releaseSlug: null, blogSlug: null, socialSlug: null });
  };

  const openRelease = (releaseSlug, sourceRoute = route, sourceTab = activeTab) => {
    setDetailBackTarget(buildBackTarget(sourceRoute, sourceTab));
    syncRoute({ page: "release-detail", artistSlug: null, releaseSlug, blogSlug: null, socialSlug: null });
  };

  const openBlogPost = (blogSlug, sourceRoute = route, sourceTab = activeTab) => {
    setDetailBackTarget(buildBackTarget(sourceRoute, sourceTab));
    syncRoute({ page: "blog-detail", artistSlug: null, releaseSlug: null, blogSlug, socialSlug: null });
  };

  const openSocialPost = (socialSlug, sourceRoute = route, sourceTab = activeTab) => {
    setDetailBackTarget(buildBackTarget(sourceRoute, sourceTab));
    syncRoute({ page: "social-detail", artistSlug: null, releaseSlug: null, blogSlug: null, socialSlug });
  };

  const goBackFromDetail = (fallbackPage) => {
    if (detailBackTarget?.route) {
      setActiveTab(detailBackTarget.route.page === "artist-detail" ? detailBackTarget.activeTab : "music");
      syncRoute(detailBackTarget.route);
      setDetailBackTarget(null);
      return;
    }

    goToPage(fallbackPage);
  };

  const visibleArtists = artists.filter((artist) => !HIDDEN_ARTIST_IDS.includes(artist.id));
  const artistNameById = new Map(visibleArtists.map((artist) => [artist.id, artist.name]));
  const artistByRouteKey = visibleArtists.reduce((map, artist) => {
    map.set(String(artist.id), artist);

    if (artist.slug) {
      map.set(artist.slug, artist);
    }

    return map;
  }, new Map());
  const artistSlugById = new Map(
    visibleArtists.map((artist) => [artist.id, artist.slug || String(artist.id)])
  );
  const normalizedReleaseLinks = releaseLinks.map(normalizeReleaseLink);
  const artistLinksByArtistId = artistLinks.reduce((map, link) => {
    const currentLinks = map.get(link.artist_id) || [];
    map.set(link.artist_id, [...currentLinks, link]);
    return map;
  }, new Map());
  const musicPageReleases = releases
    .filter((release) => !shouldHideRelease(release))
    .map((release) => ({
      ...release,
      artistName: artistNameById.get(release.artist_id) || "Unknown artist",
      artistSlug: artistSlugById.get(release.artist_id) || "",
      links: getReleaseLinksWithArtistFallback(release, normalizedReleaseLinks, artistLinksByArtistId),
    }));
  const releaseBySlug = new Map(musicPageReleases.map((release) => [release.slug, release]));
  const socialPagePosts = socialPosts.map((post) => {
    const normalizedPost = normalizeSocialPost(post, artistNameById);

    return {
      ...normalizedPost,
      artistSlug: artistSlugById.get(post.artist_id) || "",
    };
  });
  const socialPostBySlug = new Map(socialPagePosts.map((post) => [post.slug, post]));
  const blogArtistsByPostId = blogPostArtists.reduce((map, relation) => {
    const artist = artistByRouteKey.get(String(relation.artist_id));

    if (!artist) {
      return map;
    }

    const existingArtists = map.get(relation.blog_post_id) || [];

    if (!existingArtists.some((entry) => entry.id === artist.id)) {
      map.set(relation.blog_post_id, [
        ...existingArtists,
        {
          id: artist.id,
          name: artist.name,
          slug: artist.slug || String(artist.id),
        },
      ]);
    }

    return map;
  }, new Map());
  const normalizedBlogPosts = blogPosts.map((post) => {
    return normalizeBlogPost(post, blogArtistsByPostId.get(post.id) || []);
  });
  const blogPostBySlug = new Map(normalizedBlogPosts.map((post) => [post.slug, post]));
  const socialPlatforms = Array.from(
    new Set(socialPagePosts.map((post) => post.platform).filter(Boolean))
  );
  const homeEntries = [
    ...musicPageReleases.map((release) => ({
      id: `release-${release.id}`,
      title: release.title,
      artistName: release.artistName,
      slug: release.slug,
      date: formatBlogDate(release.release_date),
      excerpt: release.description || "No description yet.",
      kicker: `Release / ${getReleaseTypeLabel(release)}`,
      imageUrl: release.cover_image_url || null,
      mediaLabel: getReleaseTypeLabel(release),
      links: release.links || [],
      sortableTime: toSortableTime(release.release_date),
      kind: "release",
    })),
    ...normalizedBlogPosts.map((post) => ({
      id: `blog-${post.id}`,
      title: post.title,
      artistName: post.relatedArtists.join(" / ") || "Raw Organic Records",
      slug: post.slug,
      date: post.date,
      excerpt: post.excerpt,
      kicker: `Journal / ${post.category}`,
      imageUrl: null,
      mediaLabel: "Journal",
      links: [],
      sortableTime: post.sortableTime,
      kind: "blog",
    })),
  ]
    .sort((a, b) => b.sortableTime - a.sortableTime)
    .slice(0, 12);

  const currentArtist = route.artistSlug ? artistByRouteKey.get(route.artistSlug) || null : null;

  const currentRelease = route.releaseSlug ? releaseBySlug.get(route.releaseSlug) || null : null;
  const currentBlogPost = route.blogSlug ? blogPostBySlug.get(route.blogSlug) || null : null;
  const currentSocialPost = route.socialSlug ? socialPostBySlug.get(route.socialSlug) || null : null;

  return (
    <div className="site-shell">
      <header className="nav">
        <div className="nav-logo">
          <img
            alt="Raw Organic Records"
            className="nav-logo-image"
            src="/branding/masked-logo.png"
          />
        </div>
        <nav className="nav-links">
          {pages.map((page) => (
            <button
              key={page.id}
              className={route.page === page.id ? "active" : ""}
              onClick={() => goToPage(page.id)}
              type="button"
            >
              {page.label}
            </button>
          ))}
        </nav>
      </header>

      {route.page === "artist-detail" ? (
        <ArtistDetail
          activeTab={activeTab}
          artist={currentArtist}
          artistJournalPosts={normalizedBlogPosts.filter((post) =>
            post.relatedArtists.includes(currentArtist?.name)
          )}
          artistLinks={artistLinks}
          artistReleases={musicPageReleases.filter((release) => release.artist_id === currentArtist?.id)}
          artistId={currentArtist?.id || ""}
          onBack={() => goToPage("artists")}
          onOpenBlogPost={openBlogPost}
          onOpenRelease={openRelease}
          onTabChange={setActiveTab}
        />
      ) : null}

      {route.page === "release-detail" ? (
        <ReleaseDetail
          onBack={() => goBackFromDetail("music")}
          onOpenArtist={openArtist}
          release={currentRelease}
        />
      ) : null}

      {route.page === "blog-detail" ? (
        <BlogDetail onBack={() => goBackFromDetail("blog")} onOpenArtist={openArtist} post={currentBlogPost} />
      ) : null}

      {SOCIAL_ENABLED && route.page === "social-detail" ? (
        <SocialPostDetail
          onBack={() => goBackFromDetail("social")}
          onOpenArtist={openArtist}
          post={currentSocialPost}
        />
      ) : null}

      {route.page === "home" ? (
        <main className="page active">
          <section className="hero">
            <p className="hero-label">Independent / DC//ATX//SATX / Est. 2026</p>
            <h1 className="hero-title">Sound rooted in something real.</h1>
            <p className="hero-sub">
              Raw Organic Records is building a home for artists. No algorithms. No shortcuts.
              Just real artists, real records, and work that speaks for itself...
            </p>
          </section>

              <SectionHeader title="Latest from the label" count={`${homeEntries.length} entries`} />
              <section className="home-entry-list">
                {homeEntries.length ? (
                  homeEntries.map((entry) =>
                    entry.kind === "release" && entry.slug ? (
                      <button
                        key={entry.id}
                        className="card-button"
                        onClick={() => openRelease(entry.slug)}
                        type="button"
                      >
                        <HomeEntryCard entry={entry} />
                      </button>
                    ) : entry.kind === "blog" && entry.slug ? (
                      <button
                        key={entry.id}
                        className="card-button"
                        onClick={() => openBlogPost(entry.slug)}
                        type="button"
                      >
                        <HomeEntryCard entry={entry} />
                      </button>
                    ) : (
                      <HomeEntryCard key={entry.id} entry={entry} />
                    )
                  )
                ) : (
                  <div className="empty-state">No label entries yet.</div>
                )}
          </section>
        </main>
      ) : null}

      {route.page === "artists" ? (
        <main className="page active">
          <SectionHeader title="Artists" count={`${visibleArtists.length} artists`} />
          <div className="artists-grid">
            {visibleArtists.length ? (
              visibleArtists.map((artist) => (
                <ArtistCard
                  key={artist.id}
                  artist={artist}
                  artistLinks={artistLinksByArtistId.get(artist.id) || []}
                  onOpen={openArtist}
                />
              ))
            ) : (
              <div className="empty-state">No artists yet.</div>
            )}
          </div>
        </main>
      ) : null}

          {route.page === "music" ? (
            <main className="page active">
              <SectionHeader title="Music" count={`${musicPageReleases.length} releases`} />
              <div className="music-grid">
                {musicPageReleases.length ? (
                  musicPageReleases.map((release) =>
                    release.slug ? (
                      <button
                        key={release.id}
                        className="card-button"
                        onClick={() => openRelease(release.slug)}
                        type="button"
                      >
                        <MusicCard release={release} />
                      </button>
                    ) : (
                      <MusicCard key={release.id} release={release} />
                    )
                  )
                ) : (
                  <div className="empty-state">No releases yet.</div>
                )}
          </div>
        </main>
      ) : null}

      {SOCIAL_ENABLED && route.page === "social" ? (
        <main className="page active">
          <SectionHeader title="Social" />
          <div className="social-sections">
            {socialPlatforms.map((platform) => (
              <SocialPlatformSection
                key={platform}
                items={socialPagePosts.filter((item) => item.platform === platform)}
                onOpenPost={openSocialPost}
                platform={platform}
              />
            ))}
          </div>
        </main>
      ) : null}

      {route.page === "blog" ? (
        <main className="page active">
          <SectionHeader title="Blog" />
          <div className="blog-list">
            {normalizedBlogPosts.length ? (
              normalizedBlogPosts.map((post) => (
                <button
                  key={post.id}
                  className="card-button"
                  onClick={() => openBlogPost(post.slug)}
                  type="button"
                >
                  <BlogCard post={post} />
                </button>
              ))
            ) : (
              <div className="empty-state">No blog posts yet.</div>
            )}
          </div>
        </main>
      ) : null}
      <Analytics />
    </div>
  );
}

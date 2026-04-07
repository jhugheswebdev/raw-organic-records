export const SOCIAL_PLATFORMS = ["Instagram", "X", "Facebook", "TikTok"];

export function buildLabelModel(content) {
  const artistMap = new Map(content.artists.map((artist) => [artist.id, artist]));

  const enrichedReleases = content.releases.map((release) => ({
    ...release,
    artist: artistMap.get(release.artistId) ?? null,
  }));

  const enrichedFeedItems = content.feedItems.map((item) => ({
    ...item,
    artist: artistMap.get(item.artistId) ?? null,
  }));

  return {
    artists: content.artists,
    releases: enrichedReleases,
    blogPosts: content.blogPosts,
    feedItems: enrichedFeedItems,
    socialPlatforms: SOCIAL_PLATFORMS.map((platform) => ({
      platform,
      items: enrichedFeedItems.filter((item) => item.platform === platform),
    })),
    counts: {
      artists: content.artists.length,
      releases: content.releases.length,
      feedItems: content.feedItems.length,
      platforms: SOCIAL_PLATFORMS.length,
    },
  };
}

export function findArtist(model, artistId) {
  return model.artists.find((artist) => artist.id === artistId) ?? null;
}

export function getArtistReleases(model, artistId) {
  return model.releases.filter((release) => release.artistId === artistId);
}

export function getArtistFeed(model, artistId) {
  return model.feedItems.filter((item) => item.artistId === artistId);
}

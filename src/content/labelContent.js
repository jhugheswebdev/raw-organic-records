import { artists, blogPosts, feedItems, releases } from "./records.js";

export function getLabelContent() {
  return Promise.resolve({
    artists,
    releases,
    blogPosts,
    feedItems,
  });
}

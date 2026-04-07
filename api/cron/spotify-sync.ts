import { createSupabaseAdminClient } from "../../lib/supabaseAdmin";
import {
  fetchAlbumsAndTracksForArtists,
  getSpotifyArtistIds,
  getSpotifyArtistIdFromUrl,
  toReleaseLinkRows,
  toReleaseRows,
} from "../../lib/spotify";

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return true;
  }

  return request.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const artistIds = getSpotifyArtistIds();
    const supabase = createSupabaseAdminClient();
    const { data: artistLinks, error: artistLinksError } = await supabase
      .from("artist_links")
      .select("artist_id, platform, url, external_account_id");

    if (artistLinksError) {
      throw artistLinksError;
    }

    const spotifyArtistMap = (artistLinks || []).reduce<Record<string, string>>((map, link) => {
      if ((link.platform || "").toLowerCase() !== "spotify") {
        return map;
      }

      const spotifyArtistId =
        link.external_account_id || getSpotifyArtistIdFromUrl(link.url);

      if (spotifyArtistId && link.artist_id) {
        map[spotifyArtistId] = link.artist_id;
      }

      return map;
    }, {});

    const spotifyResults = await fetchAlbumsAndTracksForArtists(artistIds);
    const releaseRows = toReleaseRows(spotifyResults, spotifyArtistMap);
    const releaseLinkRows = toReleaseLinkRows(spotifyResults, spotifyArtistMap);

    const { error: releaseError } = await supabase
      .from("releases")
      .upsert(releaseRows, { onConflict: "id" });

    if (releaseError) {
      throw releaseError;
    }

    const { error: releaseLinkError } = await supabase
      .from("release_links")
      .upsert(releaseLinkRows, { onConflict: "id" });

    if (releaseLinkError) {
      throw releaseLinkError;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        artistCount: artistIds.length,
        mappedArtistCount: Object.keys(spotifyArtistMap).length,
        releaseCount: releaseRows.length,
        releaseLinkCount: releaseLinkRows.length,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

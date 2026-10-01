import { NextRequest, NextResponse } from "next/server";
import { extractYouTubeVideoId, isValidYouTubeUrl } from "@/lib/utils/url";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { fetchYouTubeVideoTitle } from "@/lib/youtube";
import type { ResolveVideoRequest, ResolveVideoResponse } from "@/lib/types";

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, "video/resolve", {
    limit: 20,
    windowMs: 60_000,
  });
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body: ResolveVideoRequest = await request.json();
    const { url } = body;

    if (!url || typeof url !== "string") {
      return NextResponse.json<ResolveVideoResponse>(
        { videoId: "", status: "error", message: "URL is required." },
        { status: 400 }
      );
    }

    if (!isValidYouTubeUrl(url)) {
      return NextResponse.json<ResolveVideoResponse>(
        {
          videoId: "",
          status: "error",
          message: "Invalid YouTube URL. Please paste a valid YouTube video link.",
        },
        { status: 400 }
      );
    }

    const videoId = extractYouTubeVideoId(url)!;

    // Upsert the video record so downstream APIs can reference it
    const supabase = createServiceClient();
    const title = await fetchYouTubeVideoTitle(videoId);
    const { error } = await supabase
      .from("videos")
      .upsert(
        { youtube_video_id: videoId, ...(title ? { title } : {}) },
        { onConflict: "youtube_video_id" }
      );

    if (error) {
      console.error("[resolve] supabase upsert error:", error);
      // Non-fatal — still return the videoId
    }

    // Add Video = Library membership for a signed-in caller (Phase 6). One
    // card per video: repeating it keeps the original added date and never
    // touches rounds or progress (fn_library_add_video). Guests just open
    // the video. A membership failure doesn't block opening the video.
    let libraryAdded: boolean | undefined;
    const userClient = await createClient();
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (user) {
      const { data: membership, error: membershipError } = await userClient.rpc("fn_library_add_video", {
        p_youtube_video_id: videoId,
        p_explicit: true,
      });
      if (membershipError) console.error("[resolve] library membership error:", membershipError);
      libraryAdded = membershipError ? undefined : Boolean((membership as { added?: boolean } | null)?.added);
    }

    console.log(`[resolve] videoId=${videoId}`);
    return NextResponse.json<ResolveVideoResponse>({ videoId, status: "ok", ...(libraryAdded !== undefined ? { libraryAdded } : {}) });
  } catch (err) {
    console.error("[resolve] unexpected error:", err);
    const message =
      err instanceof Error && err.message.includes("Missing Supabase")
        ? "Server is not configured yet. Please set up environment variables (see .env.local.example)."
        : "Internal server error.";
    return NextResponse.json<ResolveVideoResponse>(
      { videoId: "", status: "error", message },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { extractYouTubeVideoId, isValidYouTubeUrl } from "@/lib/utils/url";
import { createServiceClient } from "@/lib/supabase/server";
import type { ResolveVideoRequest, ResolveVideoResponse } from "@/lib/types";

export async function POST(request: NextRequest) {
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
    const { error } = await supabase
      .from("videos")
      .upsert({ youtube_video_id: videoId }, { onConflict: "youtube_video_id" });

    if (error) {
      console.error("[resolve] supabase upsert error:", error);
      // Non-fatal — still return the videoId
    }

    console.log(`[resolve] videoId=${videoId}`);
    return NextResponse.json<ResolveVideoResponse>({ videoId, status: "ok" });
  } catch (err) {
    console.error("[resolve] unexpected error:", err);
    return NextResponse.json<ResolveVideoResponse>(
      { videoId: "", status: "error", message: "Internal server error." },
      { status: 500 }
    );
  }
}

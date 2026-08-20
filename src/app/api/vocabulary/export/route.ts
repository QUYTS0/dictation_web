import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildCsvRow } from "@/lib/utils/csv";

function sanitizeAnkiTag(videoId: string): string {
  return videoId.replace(/[^A-Za-z0-9_-]/g, "_");
}

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("vocabulary_items")
      .select("term, sentence_context, note, translation, phonetic, part_of_speech, definition, video_id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[vocabulary/export] query error:", error);
      return NextResponse.json({ error: "Failed to export vocabulary" }, { status: 500 });
    }

    const rows = [buildCsvRow(["Front", "Back", "Tags"])];
    for (const item of data ?? []) {
      const pronunciationLine = [item.phonetic, item.part_of_speech].filter(Boolean).join(" · ");
      const backParts = [
        pronunciationLine,
        item.definition,
        item.translation,
        item.sentence_context,
        item.note,
      ].filter((part): part is string => Boolean(part));
      const back = backParts.join("<br>");
      rows.push(buildCsvRow([item.term, back, sanitizeAnkiTag(item.video_id)]));
    }

    const csvBody = rows.join("\r\n");

    return new NextResponse(csvBody, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="vocabulary-anki-export.csv"',
      },
    });
  } catch (err) {
    console.error("[vocabulary/export] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

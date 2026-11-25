import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapLearningReadError } from "@/lib/supabase/learningReadErrors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Gives kudos to a member of the caller's league group this week
 * (fn_league_give_kudos, migration 050): once per member per week, never to
 * yourself; repeating it changes nothing. `memberKey` is the board's opaque
 * key, never a user id. Answers { ok, kudos } (the receiver's count).
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

    const body = (await request.json().catch(() => null)) as { memberKey?: unknown } | null;
    const memberKey = body?.memberKey;
    if (typeof memberKey !== "string" || !UUID.test(memberKey)) {
      return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });
    }

    const { data, error } = await supabase.rpc("fn_league_give_kudos", { p_member_key: memberKey });
    if (error || !data) return mapLearningReadError(error, "leaderboard/kudos", "050");
    const result = data as { ok?: boolean; kudos?: number };
    return NextResponse.json({ ok: result.ok === true, kudos: Number(result.kudos) || 0 });
  } catch (err) {
    console.error("[leaderboard/kudos] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

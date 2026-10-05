import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { peekGeminiQuota } from "@/lib/ai/quota";

/**
 * Read-only status of the APPLICATION's Gemini quota (shared daily limit,
 * plus the caller's own daily limit when one is configured and they are
 * signed in), with its calendar-day reset label. Never increments anything
 * and never calls the provider. The provider's own limits and reset time
 * are an operator check — not claimed here.
 */
export async function GET() {
  let userId: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch {
    userId = null;
  }
  return NextResponse.json(await peekGeminiQuota(userId));
}

import { NextResponse } from "next/server";
import { peekGeminiQuota } from "@/lib/rateLimit";

/**
 * Read-only status for the shared Gemini free-tier budget (RPM + RPD),
 * spent by /api/ai/explain and /api/transcript/translate — lets the UI show
 * "X/Y AI calls left today" without spending a call itself. Not
 * user-specific (the quota isn't either), so no auth required.
 */
export async function GET() {
  const quota = await peekGeminiQuota();
  return NextResponse.json(quota);
}

import { NextResponse } from "next/server";
import { peekPracticeQuota } from "@/lib/practiceQuota";
import { isAzureSpeechConfigured } from "@/lib/azureSpeech";

/**
 * Read-only status for the Azure Pronunciation Assessment free-tier budget,
 * spent by /api/practice/evaluate — lets the UI show usage and hide/disable
 * the Evaluate action once the monthly limit is reached, without spending a
 * call itself. Not user-specific (the quota isn't either), so no auth
 * required — mirrors /api/ai/quota's shape for the Gemini budget.
 */
export async function GET() {
  const quota = await peekPracticeQuota();
  return NextResponse.json({ engineConfigured: isAzureSpeechConfigured(), ...quota });
}

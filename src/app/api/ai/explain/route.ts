import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { ownsAttempt } from "@/lib/supabase/ownership";
import { checkRateLimit, checkGeminiQuota } from "@/lib/rateLimit";
import { GEMINI_MODEL_NAME } from "@/lib/gemini";
import type { AIExplainRequest, AIExplainResponse } from "@/lib/types";

const EXPLAIN_RESPONSE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    explanation: { type: SchemaType.STRING },
    correctedText: { type: SchemaType.STRING },
    example: { type: SchemaType.STRING },
    tip: { type: SchemaType.STRING },
  },
  required: ["explanation", "correctedText", "example"],
};

function buildPrompt(expectedText: string, userText: string): string {
  return `You are an English language tutor. A student made a mistake while doing a dictation exercise.

Expected sentence: "${expectedText}"
Student wrote: "${userText}"

Please analyze the mistake and respond with a JSON object with these fields:
- explanation: A clear, encouraging explanation of what went wrong and why (1-2 sentences)
- correctedText: The correct sentence
- example: A similar sentence showing the correct usage
- tip: A short memory tip or grammar rule to help remember`;
}

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, "ai/explain", {
    limit: 15,
    windowMs: 60_000,
  });
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body: AIExplainRequest = await request.json();
    const { expectedText, userText, attemptId } = body;

    if (!expectedText || !userText) {
      return NextResponse.json(
        { error: "expectedText and userText are required." },
        { status: 400 }
      );
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("[ai/explain] GEMINI_API_KEY not set");
      return NextResponse.json(
        { error: "AI service not configured." },
        { status: 503 }
      );
    }

    // An attemptId only unlocks caching if the caller actually owns that
    // attempt (via its session) — otherwise we quietly fall back to
    // generating a fresh, uncached explanation instead of trusting it.
    let ownedAttemptId: string | null = null;
    if (attemptId) {
      const authClient = await createClient();
      const {
        data: { user },
      } = await authClient.auth.getUser();
      if (user && (await ownsAttempt(authClient, attemptId))) {
        ownedAttemptId = attemptId;
      } else {
        console.warn(
          `[ai/explain] ignoring attemptId=${attemptId} — not owned by caller`
        );
      }
    }

    if (ownedAttemptId) {
      const supabase = createServiceClient();
      const { data: cached } = await supabase
        .from("ai_feedback")
        .select("explanation, corrected_text, example_text")
        .eq("attempt_id", ownedAttemptId)
        .maybeSingle();

      if (cached) {
        console.log(`[ai/explain] cache hit for attemptId=${ownedAttemptId}`);
        return NextResponse.json<AIExplainResponse>({
          explanation: cached.explanation ?? "",
          correctedText: cached.corrected_text ?? expectedText,
          example: cached.example_text ?? "",
        });
      }
    }

    // Checked here (after the cache lookup above), not at the top of the
    // route, so a cache hit never spends any of the shared daily budget.
    const quota = await checkGeminiQuota();
    if (!quota.allowed) {
      const message =
        quota.reason === "rpd"
          ? "Daily AI quota reached. Try again tomorrow."
          : "AI is handling too many requests right now. Try again in a moment.";
      return NextResponse.json(
        { error: message },
        { status: 429, headers: quota.retryAfterSec ? { "Retry-After": String(quota.retryAfterSec) } : undefined }
      );
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL_NAME,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: EXPLAIN_RESPONSE_SCHEMA,
      },
    });

    const prompt = buildPrompt(expectedText, userText);
    console.log(`[ai/explain] calling Gemini for expected="${expectedText}"`);

    let parsed: AIExplainResponse | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      let rawText: string;
      try {
        const result = await Promise.race([
          model.generateContent(prompt),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("AI request timed out")), 15000)
          ),
        ]);
        rawText = result.response.text().trim();
      } catch (aiErr) {
        console.error("[ai/explain] Gemini error:", aiErr);
        return NextResponse.json(
          { error: "AI service failed. Please try again." },
          { status: 502 }
        );
      }

      try {
        // responseSchema keeps this raw in the common case; the fence-strip
        // is a safety net for any stray ```json wrapper.
        const jsonStr = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/, "");
        parsed = JSON.parse(jsonStr);
      } catch (parseErr) {
        lastError = parseErr;
        console.warn(
          `[ai/explain] failed to parse Gemini response on attempt ${attempt + 1}:`,
          rawText
        );
      }
    }

    if (!parsed) {
      console.error("[ai/explain] Gemini response unparseable after retry:", lastError);
      return NextResponse.json(
        { error: "AI returned an unexpected format." },
        { status: 502 }
      );
    }

    const response: AIExplainResponse = {
      explanation: parsed.explanation ?? "",
      correctedText: parsed.correctedText ?? expectedText,
      example: parsed.example ?? "",
      tip: parsed.tip,
    };

    // Cache the feedback if we have a verified-owned attemptId
    if (ownedAttemptId) {
      try {
        const supabase = createServiceClient();
        await supabase.from("ai_feedback").insert({
          attempt_id: ownedAttemptId,
          explanation: response.explanation,
          corrected_text: response.correctedText,
          example_text: response.example,
        });
      } catch (dbErr) {
        console.error("[ai/explain] failed to cache AI feedback:", dbErr);
      }
    }

    return NextResponse.json<AIExplainResponse>(response);
  } catch (err) {
    console.error("[ai/explain] unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}

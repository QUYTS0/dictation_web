import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createServiceClient } from "@/lib/supabase/server";
import type { AIExplainRequest, AIExplainResponse } from "@/lib/types";

const MODEL_NAME = "gemini-1.5-flash";

function buildPrompt(expectedText: string, userText: string): string {
  return `You are an English language tutor. A student made a mistake while doing a dictation exercise.

Expected sentence: "${expectedText}"
Student wrote: "${userText}"

Please analyze the mistake and respond with a JSON object in this exact format (no markdown, just raw JSON):
{
  "explanation": "A clear, encouraging explanation of what went wrong and why (1-2 sentences)",
  "correctedText": "The correct sentence",
  "example": "A similar sentence showing the correct usage",
  "tip": "A short memory tip or grammar rule to help remember"
}`;
}

export async function POST(request: NextRequest) {
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

    // Check for cached AI feedback for this attempt
    if (attemptId) {
      const supabase = createServiceClient();
      const { data: cached } = await supabase
        .from("ai_feedback")
        .select("explanation, corrected_text, example_text")
        .eq("attempt_id", attemptId)
        .maybeSingle();

      if (cached) {
        console.log(`[ai/explain] cache hit for attemptId=${attemptId}`);
        return NextResponse.json<AIExplainResponse>({
          explanation: cached.explanation ?? "",
          correctedText: cached.corrected_text ?? expectedText,
          example: cached.example_text ?? "",
        });
      }
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });

    const prompt = buildPrompt(expectedText, userText);
    console.log(`[ai/explain] calling Gemini for expected="${expectedText}"`);

    let result;
    try {
      result = await Promise.race([
        model.generateContent(prompt),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("AI request timed out")), 15000)
        ),
      ]);
    } catch (aiErr) {
      console.error("[ai/explain] Gemini error:", aiErr);
      return NextResponse.json(
        { error: "AI service failed. Please try again." },
        { status: 502 }
      );
    }

    const rawText = result.response.text().trim();

    let parsed: AIExplainResponse;
    try {
      // Strip optional ```json ... ``` wrapper
      const jsonStr = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/, "");
      parsed = JSON.parse(jsonStr);
    } catch {
      console.error("[ai/explain] failed to parse Gemini response:", rawText);
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

    // Cache the feedback if we have an attemptId
    if (attemptId) {
      try {
        const supabase = createServiceClient();
        await supabase.from("ai_feedback").insert({
          attempt_id: attemptId,
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

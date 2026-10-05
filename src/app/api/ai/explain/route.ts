import { NextRequest, NextResponse } from "next/server";
import { SchemaType, type Schema } from "@google/generative-ai";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { admissionFailure, callGeminiAdmitted, parseJsonText } from "@/lib/ai/geminiCall";
import { GEMINI_MODEL_NAME } from "@/lib/gemini";
import { resolveExplanation, type ExplanationAttempt, type StoredExplanation } from "@/lib/practice/explanationIdentity";
import {
  abandonExplanations,
  beginExplanations,
  finishExplanations,
  parseExplanationIntent,
  usableNotes,
} from "@/lib/practice/explanationPersistence";
import type { AIExplainResponse } from "@/lib/types";

// Learning Reports P4: content version stored with notes saved by this
// route. Raise it whenever the prompt or schema below changes.
const SINGLE_EXPLAIN_PROMPT_VERSION = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const NOTE_COLUMNS = "id, attempt_id, source, seq, explanation, corrected_text, example_text, tip, prompt_version, model, created_at";
const ATTEMPT_COLUMNS = "id, session_id, segment_index, expected_text, user_text, match_mode, is_correct, created_at";

/**
 * Explains ONE owned Dictation attempt (Learning Reports P4).
 * - The reference and answer come from the stored attempt row; request-body
 *   texts are ignored, so a caller can't get arbitrary text explained and
 *   saved under an attempt.
 * - intent "missing" (default) returns a saved note (own, or the same mistake
 *   in this round) without any provider call or quota; "reexplain" is the
 *   explicit request for a new note (the older one stays stored).
 * - Saved only through fn_explanations_begin/finish; never ai_feedback.
 */
export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, "ai/explain", {
    limit: 15,
    windowMs: 60_000,
  });
  if (rateLimitResponse) return rateLimitResponse;

  try {
    let body: { attemptId?: unknown; intent?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const attemptId = typeof body?.attemptId === "string" ? body.attemptId : "";
    if (!UUID_RE.test(attemptId)) {
      return NextResponse.json({ error: "attemptId is required." }, { status: 400 });
    }
    const intent = parseExplanationIntent(body?.intent);
    if (!intent) {
      return NextResponse.json({ error: 'intent must be "missing" or "reexplain".' }, { status: 400 });
    }

    const authClient = await createClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    // Owner-scoped read (attempts_owner RLS): a row is proof of ownership.
    const { data: attemptRow, error: attemptError } = await authClient
      .from("attempt_logs")
      .select(ATTEMPT_COLUMNS)
      .eq("id", attemptId)
      .maybeSingle();
    if (attemptError) {
      console.error("[ai/explain] attempt query error:", attemptError);
      return NextResponse.json({ error: "Failed to load the answer." }, { status: 500 });
    }
    if (!attemptRow) {
      return NextResponse.json({ error: "Answer not found." }, { status: 404 });
    }
    const attempt = attemptRow as ExplanationAttempt & { session_id: string };
    if (attempt.is_correct) {
      return NextResponse.json({ error: "This answer was correct — there is nothing to explain." }, { status: 409 });
    }
    const roundId = attempt.session_id;
    const service = createServiceClient();

    const readSaved = async (): Promise<AIExplainResponse | null | "error"> => {
      const [{ data: notes, error: notesError }, { data: roundAttempts, error: roundError }] = await Promise.all([
        service.from("attempt_explanations").select(NOTE_COLUMNS).eq("round_id", roundId),
        authClient.from("attempt_logs").select(ATTEMPT_COLUMNS).eq("session_id", roundId),
      ]);
      if (notesError || roundError) {
        console.error("[ai/explain] saved explanation read error:", notesError ?? roundError);
        return "error";
      }
      const resolved = resolveExplanation(
        attempt,
        (roundAttempts ?? []) as ExplanationAttempt[],
        (notes ?? []) as StoredExplanation[]
      );
      // Only the answer's own note or the same mistake's note counts as an
      // explanation of THIS answer; an earlier, different answer doesn't.
      if (!resolved || resolved.via === "earlier_answer") return null;
      return {
        explanation: resolved.explanation,
        correctedText: resolved.correctedText,
        example: resolved.example,
        ...(resolved.tip ? { tip: resolved.tip } : {}),
        saved: true,
        reused: true,
      };
    };

    if (intent === "missing") {
      const cached = await readSaved();
      if (cached === "error") {
        return NextResponse.json(
          { error: "Saved explanations couldn't be checked. Nothing was requested or charged — try again later." },
          { status: 503 }
        );
      }
      if (cached) return NextResponse.json<AIExplainResponse>(cached);
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("[ai/explain] GEMINI_API_KEY not set");
      return NextResponse.json({ error: "AI service not configured." }, { status: 503 });
    }

    // Admit the operation before any quota is spent. With intent "missing"
    // the database re-checks for a saved note under the per-round lock.
    const begin = await beginExplanations(service, {
      userId: user.id,
      roundId,
      targetAttemptIds: [attemptId],
      kind: "single",
      intent,
      promptVersion: SINGLE_EXPLAIN_PROMPT_VERSION,
      model: GEMINI_MODEL_NAME,
    });
    if (begin.status === "reuse") {
      const saved = await readSaved();
      if (saved && saved !== "error") return NextResponse.json<AIExplainResponse>(saved);
      return NextResponse.json({ error: "A saved explanation exists but couldn't be loaded. Try again." }, { status: 503 });
    }
    if (begin.status === "in_progress" || begin.status === "busy") {
      return NextResponse.json(
        { error: "An explanation for this round is already being generated. Try again in a moment — nothing was charged." },
        { status: 409 }
      );
    }
    if (begin.status === "not_found") {
      return NextResponse.json({ error: "Answer not found." }, { status: 404 });
    }
    if (begin.status !== "started") {
      console.error("[ai/explain] begin failed:", begin);
      return NextResponse.json(
        { error: "The explanation couldn't be prepared for saving. Nothing was requested or charged — try again later." },
        { status: 503 }
      );
    }
    const operation = { userId: user.id, roundId, operationId: begin.operationId, token: begin.token };

    // Every provider attempt is admitted separately (attempt 2 = the parse
    // retry); a denied or ambiguous admission never reaches the provider.
    const prompt = buildPrompt(attempt.expected_text, attempt.user_text);
    let parsed: Partial<AIExplainResponse> | null = null;
    for (const attemptNo of [1, 2] as const) {
      const res = await callGeminiAdmitted({
        apiKey,
        model: GEMINI_MODEL_NAME,
        prompt,
        responseSchema: EXPLAIN_RESPONSE_SCHEMA,
        timeoutMs: 15000,
        admission: { operationType: "explain", operationId: `explain:${roundId}:${begin.operationId}`, attempt: attemptNo, userId: user.id },
        logTag: "ai/explain",
      });
      if (res.status === "not_admitted") {
        await abandonExplanations(service, { ...operation, reason: res.admission.status === "denied" ? "quota_denied" : res.admission.status === "duplicate" ? "unknown_outcome" : "quota_unavailable" });
        if (attemptNo === 2) {
          return NextResponse.json({ error: "The AI response couldn't be read, and no AI request was left for a retry." }, { status: 502 });
        }
        const f = admissionFailure(res.admission);
        return NextResponse.json(
          { error: f.error, code: f.code },
          { status: f.status, headers: f.retryAfterSec ? { "Retry-After": String(f.retryAfterSec) } : undefined }
        );
      }
      if (res.status === "provider_error") {
        await abandonExplanations(service, { ...operation, reason: "provider_failed" });
        return NextResponse.json({ error: "AI service failed. The request may still count toward today's limit." }, { status: 502 });
      }
      const value = parseJsonText(res.text);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Partial<AIExplainResponse>;
        break;
      }
    }

    if (!parsed) {
      await abandonExplanations(service, { ...operation, reason: "unparseable" });
      return NextResponse.json(
        { error: "AI returned an unexpected format." },
        { status: 502 }
      );
    }

    const [note] = usableNotes(
      [
        {
          attemptId,
          explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
          correctedText: typeof parsed.correctedText === "string" ? parsed.correctedText : attempt.expected_text,
          example: typeof parsed.example === "string" ? parsed.example : "",
          tip: typeof parsed.tip === "string" ? parsed.tip : null,
        },
      ],
      new Set([attemptId])
    );
    if (!note) {
      await abandonExplanations(service, { ...operation, reason: "no_usable_notes" });
      return NextResponse.json({ error: "AI returned no explanation for this answer." }, { status: 502 });
    }

    const finish = await finishExplanations(service, { ...operation, notes: [note] });
    const saved = finish.status === "saved" || finish.status === "already_saved";
    if (!saved) {
      console.error("[ai/explain] failed to save the explanation:", finish);
      if (finish.status === "invalid_payload") await abandonExplanations(service, { ...operation, reason: "invalid_output" });
    }

    return NextResponse.json<AIExplainResponse>({
      explanation: note.explanation,
      correctedText: note.correctedText ?? attempt.expected_text,
      example: note.example ?? "",
      ...(note.tip ? { tip: note.tip } : {}),
      saved,
      reused: false,
    });
  } catch (err) {
    console.error("[ai/explain] unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}

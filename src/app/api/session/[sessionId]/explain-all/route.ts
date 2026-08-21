import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit, checkGeminiQuota } from "@/lib/rateLimit";
import { GEMINI_MODEL_NAME } from "@/lib/gemini";
import { normalizeText } from "@/lib/utils/text";
import type { SessionExplainAllItem, SessionExplainAllResponse } from "@/lib/types";

// Safety ceiling on DISTINCT mistake patterns sent for a full explanation —
// not on raw mistake count. Exact repeats and spacing-only slips are
// filtered out before this cap even applies, so it only bites on a session
// with 35+ genuinely different kinds of mistakes, which is rare. Kept a bit
// below the old 40 to leave output-token headroom for the assessment now
// riding in the same response. The assessment itself has no such cap — it
// reviews every mistake regardless of how many patterns get explained.
const MAX_PATTERNS_PER_REQUEST = 35;

interface Mistake {
  id: string;
  segment_index: number;
  expected_text: string;
  user_text: string;
}

interface Pattern {
  key: string;
  expectedText: string;
  userText: string;
  /** All mistakes sharing this exact (expected, typed) pair, in segment order. */
  occurrences: Mistake[];
  /** True when the only difference is whitespace/word-boundaries — a spacing slip, not a language mistake. */
  isSpacingOnly: boolean;
}

function buildPatterns(mistakes: Mistake[]): Pattern[] {
  const byKey = new Map<string, Pattern>();
  for (const mistake of mistakes) {
    const normExpected = normalizeText(mistake.expected_text, "relaxed");
    const normUser = normalizeText(mistake.user_text, "relaxed");
    const key = `${normExpected} ${normUser}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrences.push(mistake);
    } else {
      byKey.set(key, {
        key,
        expectedText: mistake.expected_text,
        userText: mistake.user_text,
        occurrences: [mistake],
        isSpacingOnly:
          normExpected.replace(/\s+/g, "") === normUser.replace(/\s+/g, "") && normExpected !== normUser,
      });
    }
  }
  // Segment order of each pattern's first occurrence — keeps the "first
  // explained, rest tagged duplicate" rule deterministic and matching the
  // order mistakes appear in the video.
  return [...byKey.values()].sort((a, b) => a.occurrences[0].segment_index - b.occurrences[0].segment_index);
}

const ASSESSMENT_PROPERTIES = {
  verdict: { type: SchemaType.STRING },
  strengths: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  weaknesses: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  recommendation: { type: SchemaType.STRING },
} as const;

const ITEM_PROPERTIES = {
  index: { type: SchemaType.INTEGER },
  status: { type: SchemaType.STRING },
  explanation: { type: SchemaType.STRING },
  correctedText: { type: SchemaType.STRING },
  example: { type: SchemaType.STRING },
  tip: { type: SchemaType.STRING },
  duplicateOfIndex: { type: SchemaType.INTEGER },
  note: { type: SchemaType.STRING },
} as const;

// One call covers both jobs: a session-wide assessment (reviews every
// mistake, small fixed-size output) plus per-pattern explanations (bounded
// by MAX_PATTERNS_PER_REQUEST, since that side scales with output tokens).
const MERGED_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    assessment: {
      type: SchemaType.OBJECT,
      properties: ASSESSMENT_PROPERTIES,
      required: ["verdict", "strengths", "weaknesses", "recommendation"],
    },
    items: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: ITEM_PROPERTIES,
        required: ["index", "status"],
      },
    },
  },
  required: ["assessment", "items"],
};

// Used only as a fallback if the merged call above fails to parse — a
// smaller, more reliable request for just the assessment, so a hiccup in
// the (bigger, riskier) item-explanation half doesn't also lose it.
const ASSESSMENT_ONLY_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    assessment: {
      type: SchemaType.OBJECT,
      properties: ASSESSMENT_PROPERTIES,
      required: ["verdict", "strengths", "weaknesses", "recommendation"],
    },
  },
  required: ["assessment"],
};

interface SessionContext {
  accuracy: number;
  totalAttempts: number;
  totalSegments: number | null;
  mistakeCount: number;
}

function formatPatternList(patterns: Pattern[], repeatWord: string): string {
  return patterns
    .map((p, i) => {
      const countSuffix = p.occurrences.length > 1 ? ` (${repeatWord} ${p.occurrences.length} times)` : "";
      return `${i + 1}. Expected: "${p.expectedText}"\n   Student wrote: "${p.userText}"${countSuffix}`;
    })
    .join("\n\n");
}

function buildAssessmentOnlyPrompt(context: SessionContext, allPatterns: Pattern[]): string {
  const segmentsLine = context.totalSegments
    ? `The video had ${context.totalSegments} sentences total; the student got ${context.mistakeCount} of them wrong (${context.accuracy}% accuracy over ${context.totalAttempts} attempts).`
    : `The student scored ${context.accuracy}% accuracy over ${context.totalAttempts} attempts, with ${context.mistakeCount} sentences wrong.`;

  return `You are an English language tutor reviewing a student's full dictation practice session. ${segmentsLine} Below is EVERY mistake pattern from the session — identical repeats of the same mistake are collapsed into one line with a repeat count, so this list accounts for all ${context.mistakeCount} mistakes exactly, not a sample.

${formatPatternList(allPatterns, "repeated")}

Respond with a single JSON object: { "assessment": { "verdict", "strengths", "weaknesses", "recommendation" } }.
- "verdict": one encouraging sentence summarizing how the whole session went
- "strengths": 2-4 short bullet points on what the student is doing well
- "weaknesses": 2-4 short bullet points on the recurring patterns behind these mistakes — pay attention to which mistakes repeated most
- "recommendation": one concrete, actionable next step

Base this entirely on the full list above, including the repeat counts.`;
}

function buildMergedPrompt(context: SessionContext, allPatterns: Pattern[], explainPatterns: Pattern[]): string {
  const segmentsLine = context.totalSegments
    ? `The video had ${context.totalSegments} sentences total; the student got ${context.mistakeCount} of them wrong (${context.accuracy}% accuracy over ${context.totalAttempts} attempts).`
    : `The student scored ${context.accuracy}% accuracy over ${context.totalAttempts} attempts, with ${context.mistakeCount} sentences wrong.`;

  return `You are an English language tutor reviewing a student's full dictation practice session. ${segmentsLine}

Below is EVERY mistake pattern from the session — identical repeats of the same mistake are collapsed into one line with a repeat count, so this list accounts for all ${context.mistakeCount} mistakes exactly, not a sample:

${formatPatternList(allPatterns, "repeated")}

Respond with a single JSON object with two top-level fields, "assessment" and "items".

1. "assessment" — a structured overall performance review of the WHOLE session above:
   - "verdict": one encouraging sentence summarizing how the session went overall
   - "strengths": 2-4 short bullet points on what the student is doing well
   - "weaknesses": 2-4 short bullet points on the recurring patterns behind these mistakes — pay attention to which mistakes repeated most
   - "recommendation": one concrete, actionable next step

2. "items" — per-sentence detail, but ONLY for these ${explainPatterns.length} distinct patterns (a subset of the list above with exact repeats already removed, renumbered 1-${explainPatterns.length}):

${formatPatternList(explainPatterns, "this exact mistake happened")}

For EACH of these ${explainPatterns.length} numbered items, decide whether it warrants a full explanation, and return one array element:
- If it's a trivial slip that doesn't reflect a real language gap (e.g. purely a spacing/word-boundary issue), set "status": "minor" with a one-sentence "note" — do NOT write a full explanation for these.
- If it represents the SAME underlying language issue as an earlier item in THIS list (same word confused, same grammar rule missed — even if the sentence is different), set "status": "duplicate", "duplicateOfIndex" to that earlier item's number, and a short "note" like "Same issue as #<n>".
- Otherwise, set "status": "explained" and fill in "explanation" (1-2 sentences), "correctedText", "example", and an optional "tip".

Always include "index" (the item's number in this second list, 1-based) and "status". Return exactly ${explainPatterns.length} array elements, one per item, in any order. Keep everything concise — this single response covers the whole session.`;
}

interface RouteParams {
  params: Promise<{ sessionId: string }>;
}

type ParsedAssessment = { verdict: string; strengths: string[]; weaknesses: string[]; recommendation: string };
type ParsedItem = {
  index: number;
  status?: string;
  explanation?: string;
  correctedText?: string;
  example?: string;
  tip?: string;
  duplicateOfIndex?: number;
  note?: string;
};

export async function POST(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, "ai/explain-all", {
    limit: 8,
    windowMs: 60_000,
  });
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const { sessionId } = await params;
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const { data: session, error: sessionError } = await supabase
      .from("learning_sessions")
      .select("id, transcript_id, accuracy, total_attempts")
      .eq("id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (sessionError) {
      console.error("[session/explain-all] session query error:", sessionError);
      return NextResponse.json({ error: "Failed to load session" }, { status: 500 });
    }
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const [{ data: attempts, error: attemptsError }, { count: totalSegments, error: segmentsError }] =
      await Promise.all([
        supabase
          .from("attempt_logs")
          .select("id, segment_index, expected_text, user_text, created_at")
          .eq("session_id", sessionId)
          .eq("is_correct", false)
          .order("segment_index", { ascending: true })
          .order("created_at", { ascending: true }),
        session.transcript_id
          ? supabase
              .from("transcript_segments")
              .select("id", { head: true, count: "exact" })
              .eq("transcript_id", session.transcript_id)
          : Promise.resolve({ count: null, error: null }),
      ]);

    if (attemptsError) {
      console.error("[session/explain-all] attempts query error:", attemptsError);
      return NextResponse.json({ error: "Failed to load mistakes" }, { status: 500 });
    }
    if (segmentsError) {
      console.error("[session/explain-all] segments count error:", segmentsError);
      return NextResponse.json({ error: "Failed to load session" }, { status: 500 });
    }

    // One mistake per segment — keep the latest wrong attempt, matching the
    // dedupe logic in /api/session/[sessionId]/report.
    const latestBySegment = new Map<number, Mistake>();
    for (const attempt of attempts ?? []) {
      latestBySegment.set(attempt.segment_index, attempt);
    }
    const mistakes = [...latestBySegment.values()].sort((a, b) => a.segment_index - b.segment_index);

    if (mistakes.length === 0) {
      return NextResponse.json<SessionExplainAllResponse>({
        items: [],
        assessment: null,
        mistakesReviewed: 0,
        uniquePatternsExplained: 0,
        truncated: false,
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("[session/explain-all] GEMINI_API_KEY not set");
      return NextResponse.json({ error: "AI service not configured." }, { status: 503 });
    }

    // Exact repeats and spacing-only slips are collapsed/filtered
    // deterministically here — no AI judgment needed for either, and it
    // shrinks what actually needs to go to Gemini for real explanation.
    const allPatterns = buildPatterns(mistakes);
    const spacingOnlyPatterns = allPatterns.filter((p) => p.isSpacingOnly);
    const candidatePatterns = allPatterns.filter((p) => !p.isSpacingOnly);
    const truncated = candidatePatterns.length > MAX_PATTERNS_PER_REQUEST;
    const explainPatterns = candidatePatterns.slice(0, MAX_PATTERNS_PER_REQUEST);
    const overflowPatterns = candidatePatterns.slice(MAX_PATTERNS_PER_REQUEST);

    const context: SessionContext = {
      accuracy: Math.round(Number(session.accuracy ?? 0)),
      totalAttempts: session.total_attempts ?? 0,
      totalSegments: totalSegments ?? null,
      mistakeCount: mistakes.length,
    };

    const genAI = new GoogleGenerativeAI(apiKey);

    let quota = await checkGeminiQuota();
    if (!quota.allowed) return quotaErrorResponse(quota);

    const mergedModel = genAI.getGenerativeModel({
      model: GEMINI_MODEL_NAME,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: MERGED_SCHEMA,
        // Both the assessment and every distinct mistake pattern's
        // explanation ride in this one response — explicit headroom so it
        // can't get silently truncated partway through.
        maxOutputTokens: 8192,
      },
    });
    console.log(
      `[session/explain-all] merged call: ${mistakes.length} mistakes / ${allPatterns.length} patterns, ${explainPatterns.length} to explain (session=${sessionId})`
    );

    let assessment: ParsedAssessment;
    let parsedItems: ParsedItem[];

    const mergedResult = await callGeminiJson<{ assessment: ParsedAssessment; items: ParsedItem[] }>(
      mergedModel,
      buildMergedPrompt(context, allPatterns, explainPatterns),
      (v) => !!v && typeof v === "object" && "assessment" in v && Array.isArray((v as { items?: unknown }).items),
      // Generating up to MAX_PATTERNS_PER_REQUEST full explanations plus the
      // assessment in one go can genuinely take longer than a short reply —
      // seen in practice timing out at the old 30s default on a large batch.
      55000
    );

    if (mergedResult.ok) {
      assessment = mergedResult.value.assessment;
      parsedItems = mergedResult.value.items;
    } else {
      // The merged call failed (e.g. truncated output) — fall back to a
      // smaller, more reliable assessment-only request so a hiccup in the
      // item-explanation half doesn't also cost the (cheap, safe) assessment.
      quota = await checkGeminiQuota();
      if (!quota.allowed) return mergedResult.response;

      const assessmentOnlyModel = genAI.getGenerativeModel({
        model: GEMINI_MODEL_NAME,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: ASSESSMENT_ONLY_SCHEMA,
          maxOutputTokens: 2048,
        },
      });
      const fallback = await callGeminiJson<{ assessment: ParsedAssessment }>(
        assessmentOnlyModel,
        buildAssessmentOnlyPrompt(context, allPatterns),
        (v) => !!v && typeof v === "object" && "assessment" in v
      );
      if (!fallback.ok) return mergedResult.response;

      assessment = fallback.value.assessment;
      parsedItems = [];
    }

    // Persist right away — so the assessment survives a page reload or a
    // later visit to this report instead of only living in React state.
    // Logged, not fatal: if the 010_session_assessment migration hasn't
    // been applied yet, the column won't exist and this just no-ops.
    const { error: assessmentSaveError } = await supabase
      .from("learning_sessions")
      .update({ ai_assessment: assessment, ai_assessment_generated_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("user_id", user.id);
    if (assessmentSaveError) {
      console.warn(
        "[session/explain-all] failed to persist assessment (migration 010 may not be applied yet):",
        assessmentSaveError
      );
    }

    // parsedItems is empty specifically in the assessment-only fallback
    // path — there's no item data to map in that case (buildItemsFromResult
    // would otherwise treat every pattern as "explained" with blank text).
    // Those mistakes simply get no AI feedback this round; the user can
    // retry "Explain all" for another attempt at the per-mistake half.
    const { items, feedbackRowsToInsert } =
      parsedItems.length > 0
        ? buildItemsFromResult(parsedItems, explainPatterns)
        : { items: [] as SessionExplainAllItem[], feedbackRowsToInsert: [] as ReturnType<typeof buildItemsFromResult>["feedbackRowsToInsert"] };

    if (feedbackRowsToInsert.length > 0) {
      // ai_feedback writes require the service-role client (RLS only grants
      // owners SELECT); ownership was already verified above via the
      // cookie-scoped client. Clear previous rows for these attempts first —
      // re-running should replace last time's cache, not accumulate
      // duplicate rows.
      const serviceClient = createServiceClient();
      const attemptIds = feedbackRowsToInsert.map((r) => r.attempt_id);
      const { error: deleteError } = await serviceClient.from("ai_feedback").delete().in("attempt_id", attemptIds);
      if (deleteError) {
        console.error("[session/explain-all] failed to clear old cached feedback:", deleteError);
      }
      const { error: insertError } = await serviceClient.from("ai_feedback").insert(feedbackRowsToInsert);
      if (insertError) {
        console.error("[session/explain-all] failed to cache AI feedback:", insertError);
      }
    }

    items.push(...buildFallbackItems(spacingOnlyPatterns, overflowPatterns));

    return NextResponse.json<SessionExplainAllResponse>({
      items,
      assessment,
      mistakesReviewed: mistakes.length,
      uniquePatternsExplained: parsedItems.length > 0 ? explainPatterns.length : 0,
      truncated,
    });
  } catch (err) {
    console.error("[session/explain-all] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

function buildItemsFromResult(
  parsedItems: ParsedItem[],
  explainPatterns: Pattern[]
): {
  items: SessionExplainAllItem[];
  feedbackRowsToInsert: Array<{ attempt_id: string; explanation: string; corrected_text: string; example_text: string }>;
} {
  const items: SessionExplainAllItem[] = [];
  const feedbackRowsToInsert: Array<{
    attempt_id: string;
    explanation: string;
    corrected_text: string;
    example_text: string;
  }> = [];
  const byIndex = new Map(parsedItems.map((p) => [p.index, p]));

  explainPatterns.forEach((pattern, i) => {
    const promptIndex = i + 1;
    const result = byIndex.get(promptIndex) ?? parsedItems[i];
    const rawStatus = result?.status;
    const status: "explained" | "duplicate" | "minor" =
      rawStatus === "minor" ? "minor" : rawStatus === "duplicate" ? "duplicate" : "explained";

    const [firstOccurrence, ...repeats] = pattern.occurrences;

    if (status === "minor") {
      const note = result?.note ?? "A minor slip, not a language issue.";
      for (const occurrence of pattern.occurrences) items.push(minorItem(occurrence.id, note));
      return;
    }

    if (status === "duplicate") {
      const referencedPattern = explainPatterns[(result?.duplicateOfIndex ?? 1) - 1] ?? explainPatterns[0];
      const referencedSegment = referencedPattern.occurrences[0].segment_index;
      const note = result?.note ?? `Same underlying issue as Sentence ${referencedSegment + 1}`;
      for (const occurrence of pattern.occurrences) items.push(duplicateItem(occurrence.id, referencedSegment, note));
      return;
    }

    // "explained" — first occurrence gets the full card; any exact repeats
    // of this same pattern are tagged as duplicates of it.
    const explanation = result?.explanation ?? "";
    const correctedText = result?.correctedText ?? pattern.expectedText;
    const example = result?.example ?? "";
    const tip = result?.tip;

    items.push({ attemptId: firstOccurrence.id, status: "explained", explanation, correctedText, example, tip });
    feedbackRowsToInsert.push({
      attempt_id: firstOccurrence.id,
      explanation,
      corrected_text: correctedText,
      example_text: example,
    });
    for (const repeat of repeats) {
      items.push(
        duplicateItem(
          repeat.id,
          firstOccurrence.segment_index,
          `Identical mistake — same as Sentence ${firstOccurrence.segment_index + 1}`
        )
      );
    }
  });

  return { items, feedbackRowsToInsert };
}

function minorItem(attemptId: string, note: string): SessionExplainAllItem {
  return { attemptId, status: "minor", explanation: "", correctedText: "", example: "", note };
}

function duplicateItem(attemptId: string, duplicateOfSegmentIndex: number, note: string): SessionExplainAllItem {
  return {
    attemptId,
    status: "duplicate",
    explanation: "",
    correctedText: "",
    example: "",
    duplicateOfSegmentIndex,
    note,
  };
}

/** Spacing-only slips (never sent to Gemini) and any patterns past the cap, tagged so the client still gets a row for every mistake. */
function buildFallbackItems(spacingOnlyPatterns: Pattern[], overflowPatterns: Pattern[]): SessionExplainAllItem[] {
  const items: SessionExplainAllItem[] = [];
  for (const pattern of spacingOnlyPatterns) {
    for (const occurrence of pattern.occurrences) {
      items.push(minorItem(occurrence.id, "Just a spacing/word-boundary slip, not a language issue."));
    }
  }
  for (const pattern of overflowPatterns) {
    for (const occurrence of pattern.occurrences) {
      items.push(minorItem(occurrence.id, "Not explained — this session had more distinct mistakes than fit in one batch."));
    }
  }
  return items;
}

function quotaErrorResponse(quota: { reason?: "rpm" | "rpd"; retryAfterSec?: number }) {
  const message =
    quota.reason === "rpd"
      ? "Daily AI quota reached. Try again tomorrow."
      : "AI is handling too many requests right now. Try again in a moment.";
  return NextResponse.json(
    { error: message },
    { status: 429, headers: quota.retryAfterSec ? { "Retry-After": String(quota.retryAfterSec) } : undefined }
  );
}

/** Calls Gemini, parses the JSON response, and retries once on a malformed/unparseable body. */
async function callGeminiJson<T>(
  model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>,
  prompt: string,
  isValid: (value: unknown) => boolean,
  timeoutMs = 30000
): Promise<{ ok: true; value: T } | { ok: false; response: NextResponse }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let rawText: string;
    try {
      const result = await Promise.race([
        model.generateContent(prompt),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AI request timed out")), timeoutMs)),
      ]);
      rawText = result.response.text().trim();
    } catch (aiErr) {
      console.error("[session/explain-all] Gemini error:", aiErr);
      return { ok: false, response: NextResponse.json({ error: "AI service failed. Please try again." }, { status: 502 }) };
    }

    try {
      const jsonStr = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/, "");
      const parsed = JSON.parse(jsonStr);
      if (isValid(parsed)) return { ok: true, value: parsed as T };
      lastError = new Error("Response failed shape validation");
    } catch (parseErr) {
      lastError = parseErr;
    }
    console.warn(`[session/explain-all] failed to parse Gemini response on attempt ${attempt + 1}:`, rawText!);
  }

  console.error("[session/explain-all] Gemini response unparseable after retry:", lastError);
  return { ok: false, response: NextResponse.json({ error: "AI returned an unexpected format." }, { status: 502 }) };
}

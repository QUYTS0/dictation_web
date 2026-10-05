import { NextRequest, NextResponse } from "next/server";
import { aiRouteContext, readJsonBody } from "@/lib/ai/routeContext";
import { runExplain } from "@/lib/ai/assessmentPipeline";
import { MAX_EXPLANATION_BATCH } from "@/lib/ai/assessmentInput";

interface RouteParams {
  params: Promise<{ sessionId: string }>;
}

/**
 * Learning Reports P5 — explanations only (the overview is never touched).
 * Body: { intent?: "missing" | "reexplain", sentences?: number[] (0-based) }
 *   missing   — the next ≤ 35 missing targets (or the selected sentences'
 *               missing targets); saved notes are never paid for again.
 *   reexplain — explicit replacement of the selected sentences' notes
 *               (sentences required); older notes stay stored as history.
 * One batch per request; there is no automatic loop.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { sessionId } = await params;
  const ctx = await aiRouteContext(request, "ai/explanations", sessionId);
  if (!ctx.ok) return ctx.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const intent = body.body.intent ?? "missing";
  if (intent !== "missing" && intent !== "reexplain") {
    return NextResponse.json({ error: 'intent must be "missing" or "reexplain".', code: "bad_request" }, { status: 400 });
  }
  const s = body.body.sentences;
  if (
    s !== undefined &&
    (!Array.isArray(s) || s.length > MAX_EXPLANATION_BATCH || !s.every((n) => Number.isInteger(n) && n >= 0 && n < 100_000))
  ) {
    return NextResponse.json({ error: `sentences must be up to ${MAX_EXPLANATION_BATCH} sentence indexes.`, code: "bad_request" }, { status: 400 });
  }
  try {
    const result = await runExplain(ctx, { intent, sentences: s as number[] | undefined });
    return NextResponse.json(result.body, { status: result.httpStatus });
  } catch (err) {
    console.error("[ai/explanations] unexpected error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error", code: "internal" }, { status: 500 });
  }
}

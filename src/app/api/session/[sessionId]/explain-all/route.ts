import { NextRequest, NextResponse } from "next/server";
import { aiRouteContext, readJsonBody } from "@/lib/ai/routeContext";
import { runGenerate } from "@/lib/ai/assessmentPipeline";
import { legacyMirror } from "@/lib/ai/legacyMirror";
import type { AiActionResponse } from "@/lib/ai/types";
import type { ExplainAllExplanationsOutcome, SessionExplainAllItem, SessionExplainAllResponse } from "@/lib/types";

interface RouteParams {
  params: Promise<{ sessionId: string }>;
}

/**
 * COMPATIBILITY endpoint (Learning Reports P5) for report pages opened
 * before P5 was deployed. It runs exactly the new "Generate assessment"
 * pipeline — same begin/admission/finish, same reuse and recovery rules —
 * and answers in the old response shape. Stale tabs therefore can't bypass
 * the new quota or storage; they just see less detail until reloaded
 * (saved notes appear after a reload). Current pages use
 * POST /api/session/[id]/assessment.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { sessionId } = await params;
  const ctx = await aiRouteContext(request, "ai/explain-all", sessionId);
  if (!ctx.ok) return ctx.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (body.body.intent !== undefined && body.body.intent !== "missing") {
    return NextResponse.json({ error: "Reload the page to re-explain specific sentences." }, { status: 400 });
  }
  try {
    const result = await runGenerate(ctx);
    if (result.httpStatus !== 200) {
      return NextResponse.json({ error: (result.body as { error: string }).error }, { status: result.httpStatus });
    }
    const r = result.body as AiActionResponse;
    const items: SessionExplainAllItem[] = (r.explanations.unsaved ?? []).map((n) =>
      n.kind === "explanation"
        ? { attemptId: n.attemptId, status: "explained", explanation: n.explanation, correctedText: n.correctedText ?? "", example: n.example ?? "", unsaved: true }
        : { attemptId: n.attemptId, status: "minor", explanation: "", correctedText: "", example: "", note: n.explanation, unsaved: true }
    );
    const status: ExplainAllExplanationsOutcome["status"] =
      r.explanations.status === "saved"
        ? "saved"
        : r.explanations.status === "not_saved"
          ? "not_saved"
          : r.explanations.status === "none_usable"
            ? "none_usable"
            : r.explanations.status === "no_targets"
              ? "no_targets"
              : "reused";
    const legacy: SessionExplainAllResponse = {
      items,
      assessment: r.overview.payload ? legacyMirror(r.overview.payload) : null,
      mistakesReviewed: r.overview.meta?.evidence.total ?? 0,
      uniquePatternsExplained: r.explanations.requested,
      truncated: r.explanations.remaining > 0,
      assessmentSaved: r.overview.status === "saved",
      explanations: {
        status,
        requested: r.explanations.requested,
        saved: r.explanations.saved,
        alreadySaved: 0,
        remaining: r.explanations.remaining,
      },
    };
    return NextResponse.json(legacy);
  } catch (err) {
    console.error("[ai/explain-all] unexpected error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

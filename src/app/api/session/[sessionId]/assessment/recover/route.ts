import { NextRequest, NextResponse } from "next/server";
import { aiRouteContext, readJsonBody } from "@/lib/ai/routeContext";
import { runRecover } from "@/lib/ai/assessmentRecover";

interface RouteParams {
  params: Promise<{ sessionId: string }>;
}

/**
 * Learning Reports P5 — save a result that was generated but not stored.
 * Body: { entries: AiRecoveryEntry[] } (1–2: overview and/or explanations,
 * each verified and saved independently). Authenticated and owner-scoped;
 * never calls the provider, never charges quota.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { sessionId } = await params;
  const ctx = await aiRouteContext(request, "ai/assessment-recover", sessionId, 20);
  if (!ctx.ok) return ctx.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  try {
    const result = await runRecover(ctx, body.body.entries as unknown[]);
    return NextResponse.json(result.body, { status: result.httpStatus });
  } catch (err) {
    console.error("[ai/assessment-recover] unexpected error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error", code: "internal" }, { status: 500 });
  }
}

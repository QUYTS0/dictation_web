import { NextRequest, NextResponse } from "next/server";
import { aiRouteContext, readJsonBody } from "@/lib/ai/routeContext";
import { runGenerate } from "@/lib/ai/assessmentPipeline";

interface RouteParams {
  params: Promise<{ sessionId: string }>;
}

/**
 * Learning Reports P5 — "Generate / Update / Regenerate assessment" for one
 * owned round: the overview plus the first missing explanation batch (≤ 35),
 * one admitted provider request (+ at most one admitted parse retry).
 * A compatible saved assessment is reused with no provider call. Explicit
 * user action only — the report GET never calls this.
 * Body: {} (reserved: { action?: "generate" }).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { sessionId } = await params;
  const ctx = await aiRouteContext(request, "ai/assessment", sessionId);
  if (!ctx.ok) return ctx.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (body.body.action !== undefined && body.body.action !== "generate") {
    return NextResponse.json({ error: 'action must be "generate".', code: "bad_request" }, { status: 400 });
  }
  try {
    const result = await runGenerate(ctx);
    return NextResponse.json(result.body, { status: result.httpStatus });
  } catch (err) {
    console.error("[ai/assessment] unexpected error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error", code: "internal" }, { status: 500 });
  }
}

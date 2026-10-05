/**
 * Learning Reports P5 — common prelude for the AI POST routes: rate limit,
 * authenticated user, a round id that is a UUID. Ownership itself is checked
 * by the owner-scoped reads and again by every SECURITY DEFINER RPC.
 */
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function aiRouteContext(
  request: NextRequest,
  routeName: string,
  roundId: string | undefined,
  limit = 8
): Promise<{ ok: true; userId: string; roundId: string; userClient: SupabaseClient; service: SupabaseClient } | { ok: false; response: NextResponse }> {
  const limited = await checkRateLimit(request, routeName, { limit, windowMs: 60_000 });
  if (limited) return { ok: false, response: limited };
  if (!roundId || !UUID_RE.test(roundId)) {
    return { ok: false, response: NextResponse.json({ error: "Invalid round id.", code: "bad_request" }, { status: 400 }) };
  }
  const userClient = (await createClient()) as unknown as SupabaseClient;
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "Authentication required", code: "unauthenticated" }, { status: 401 }) };
  return { ok: true, userId: user.id, roundId, userClient, service: createServiceClient() as unknown as SupabaseClient };
}

export async function readJsonBody(request: NextRequest): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  const raw = await request.text().catch(() => "");
  if (!raw.trim()) return { ok: true, body: {} };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, body: v as Record<string, unknown> };
  } catch {
    /* fall through */
  }
  return { ok: false, response: NextResponse.json({ error: "Invalid JSON body.", code: "bad_request" }, { status: 400 }) };
}

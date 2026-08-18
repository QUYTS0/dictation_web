import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Verifies that `sessionId` belongs to `userId`. Callers must pass the
 * cookie-based (RLS-respecting) client from `createClient()`, not the
 * service-role client — this doubles as a second, explicit check on top of
 * the `sessions_owner` RLS policy.
 */
export async function ownsSession(
  supabase: SupabaseClient,
  userId: string,
  sessionId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("learning_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

/**
 * Verifies that `attemptId` belongs to the caller. Must be called with the
 * cookie-based (RLS-respecting) client — the `attempts_owner` RLS policy
 * already scopes `attempt_logs` selects to rows whose session is owned by
 * `auth.uid()`, so a returned row is proof of ownership on its own.
 */
export async function ownsAttempt(
  supabase: SupabaseClient,
  attemptId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("attempt_logs")
    .select("id")
    .eq("id", attemptId)
    .maybeSingle();
  return !!data;
}

"use client";

import { createBrowserClient } from "@supabase/ssr";

function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// Reuse a single browser client instead of creating a new GoTrueClient per
// call. Multiple instances each try to acquire the same Web Lock for auth
// token refresh, which causes "Lock ... was not released" errors.
let client: ReturnType<typeof createSupabaseBrowserClient> | undefined;

export function createClient() {
  if (!client) {
    client = createSupabaseBrowserClient();
  }
  return client;
}

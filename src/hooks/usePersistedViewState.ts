"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Persists a flat set of string view-state values (search text, filter
 * selections, ...) across client-side navigation between the app's nav
 * tabs, scoped per signed-in user and per page.
 *
 * sessionStorage is the source of truth for surviving a bare nav-tab click:
 * AppHeader's links are plain paths with no query string, by design (kept
 * that way rather than coupling a shared nav component to each page's own
 * state shape) — a URL-only scheme would lose everything on every tab
 * click. The URL is still kept in sync — both on an explicit `update()`
 * call and, once, right after a sessionStorage restore — purely so
 * direct/shared links and browser Back/Forward carry the same state a bare
 * nav-tab return would have restored anyway.
 *
 * Precedence on load is all-or-nothing, not per-field: if the URL carries
 * *any* of these params, the whole set is taken from the URL for this load
 * (missing individual params fall back to `defaults`, not to a stored
 * value) — a partial deep link like `?q=foo` shouldn't silently blend in an
 * unrelated filter remembered from a different session. Only when the URL
 * carries none of them does the stored value apply.
 *
 * Mirrors the URL-first, storage-in-an-effect pattern already used by
 * useInputModePreference.ts: reading searchParams synchronously can't cause
 * a hydration mismatch (Next.js resolves it identically server/client from
 * the request URL); reading sessionStorage can, so that part waits for a
 * post-mount effect.
 *
 * Returns a third `hydrated` flag: `false` until that post-mount
 * resolution has actually run (or determined there was nothing to run,
 * e.g. no signed-in user yet). Consumers that derive DOM layout from this
 * state (notably scroll restoration) must wait for `hydrated` — otherwise
 * they'd measure/restore against the one-frame flash of `defaults` that
 * renders before a stored value overwrites it, exactly the "restore too
 * early, then jump again once the real filters apply" bug this flag
 * exists to prevent.
 */
export function usePersistedViewState<K extends string>(
  storageNamespace: string,
  userId: string | undefined,
  defaults: Record<K, string>
): [Record<K, string>, (patch: Partial<Record<K, string>>) => void, boolean] {
  const router = useRouter();
  const searchParams = useSearchParams();
  const keys = Object.keys(defaults) as K[];

  // Effects below intentionally run only on [userId, storageNamespace] (see
  // the comment on that effect) — these refs give them access to the
  // *latest* defaults/keys without retriggering on every render, since
  // callers pass a fresh object/array literal each time.
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const keysRef = useRef(keys);
  keysRef.current = keys;

  const [state, setState] = useState<Record<K, string>>(() => {
    const fromUrl: Partial<Record<K, string>> = {};
    for (const key of keys) {
      const value = searchParams.get(key);
      if (value !== null) fromUrl[key] = value;
    }
    return { ...defaults, ...fromUrl };
  });
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!userId) {
      // Nothing to hydrate without a signed-in user yet; once userId
      // arrives this effect reruns (it's a dependency) and does the real
      // resolution then.
      setHydrated(true);
      return;
    }
    const hasAnyUrlParam = keysRef.current.some((key) => searchParams.get(key) !== null);
    if (!hasAnyUrlParam) {
      try {
        const raw = window.sessionStorage.getItem(`${storageNamespace}:${userId}`);
        if (raw) {
          const stored = JSON.parse(raw) as Partial<Record<K, string>>;
          const next = { ...defaultsRef.current, ...stored };
          setState(next);
          // Mirror the restored state into the URL too (matches what an
          // explicit `update()` call does), so a bare nav-tab return is
          // reload-safe and shareable, not just applied in memory.
          const params = new URLSearchParams(window.location.search);
          for (const key of keysRef.current) {
            const value = next[key];
            if (!value || value === defaultsRef.current[key]) params.delete(key);
            else params.set(key, value);
          }
          const qs = params.toString();
          router.replace(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
        }
      } catch {
        // sessionStorage can throw (private browsing, quota) — proceed without it.
      }
    }
    setHydrated(true);
    // Deliberately excludes `searchParams`/`router`: this restore should
    // only run once per account, on mount, not re-run every time `update`
    // below changes the URL itself (that already updates state directly).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, storageNamespace]);

  const update = useCallback(
    (patch: Partial<Record<K, string>>) => {
      setState((prev) => {
        const next = { ...prev, ...patch };
        if (typeof window !== "undefined" && userId) {
          try {
            window.sessionStorage.setItem(`${storageNamespace}:${userId}`, JSON.stringify(next));
          } catch {
            // ignore
          }
        }
        if (typeof window !== "undefined") {
          const params = new URLSearchParams(window.location.search);
          for (const key of keys) {
            const value = next[key];
            if (!value || value === defaults[key]) params.delete(key);
            else params.set(key, value);
          }
          const qs = params.toString();
          router.replace(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
        }
        return next;
      });
    },
    [router, userId, storageNamespace, defaults, keys]
  );

  return [state, update, hydrated];
}

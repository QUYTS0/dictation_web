/**
 * Focused tests for src/lib/supabase/ownership.ts, added alongside
 * ownsStudySession (Phase 1 — see .claude/video-learning-management-plan.md
 * §8/§12). No prior test file covered ownsSession/ownsAttempt at all; this
 * file adds the four required ownsStudySession cases plus matching
 * coverage for the two pre-existing helpers so a future change to any of
 * the three is caught the same way.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ownsSession, ownsAttempt, ownsStudySession } from "@/lib/supabase/ownership";

type QueryResult = { data: unknown; error: unknown };

function makeClient(result: QueryResult | (() => QueryResult)) {
  const eqMock = jest.fn();
  const maybeSingleMock = jest.fn(async () => (typeof result === "function" ? result() : result));
  const builder: Record<string, unknown> = {};
  builder.select = jest.fn(() => builder);
  eqMock.mockImplementation(() => builder);
  builder.eq = eqMock;
  builder.maybeSingle = maybeSingleMock;
  const fromMock = jest.fn(() => builder);
  return {
    client: { from: fromMock } as unknown as SupabaseClient,
    fromMock,
    eqMock,
    maybeSingleMock,
  };
}

describe("ownsStudySession", () => {
  it("returns true when the caller owns the study session", async () => {
    const { client, fromMock, eqMock } = makeClient({ data: { id: "study-1" }, error: null });
    const owned = await ownsStudySession(client, "user-1", "study-1");
    expect(owned).toBe(true);
    expect(fromMock).toHaveBeenCalledWith("study_sessions");
    expect(eqMock).toHaveBeenCalledWith("id", "study-1");
    expect(eqMock).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("returns false when another user owns the study session", async () => {
    // RLS (study_sessions_owner_select) or the explicit .eq("user_id", ...)
    // filter would both cause this row to come back empty for a
    // non-owning caller — either way, no row means not owned.
    const { client } = makeClient({ data: null, error: null });
    const owned = await ownsStudySession(client, "user-2", "study-1");
    expect(owned).toBe(false);
  });

  it("returns false when the study session does not exist", async () => {
    const { client } = makeClient({ data: null, error: null });
    const owned = await ownsStudySession(client, "user-1", "does-not-exist");
    expect(owned).toBe(false);
  });

  it("returns false (not a throw) when the database request fails", async () => {
    const { client } = makeClient({ data: null, error: { message: "connection reset" } });
    await expect(ownsStudySession(client, "user-1", "study-1")).resolves.toBe(false);
  });
});

describe("ownsSession (existing behavior, unchanged)", () => {
  it("returns true for the owner, false for a non-owner/missing row, and false (not a throw) on a DB error", async () => {
    const owned = makeClient({ data: { id: "sess-1" }, error: null });
    await expect(ownsSession(owned.client, "user-1", "sess-1")).resolves.toBe(true);

    const notOwned = makeClient({ data: null, error: null });
    await expect(ownsSession(notOwned.client, "user-2", "sess-1")).resolves.toBe(false);

    const failed = makeClient({ data: null, error: { message: "timeout" } });
    await expect(ownsSession(failed.client, "user-1", "sess-1")).resolves.toBe(false);
  });
});

describe("ownsAttempt (existing behavior, unchanged)", () => {
  it("returns true when a row comes back, false otherwise, and false (not a throw) on a DB error", async () => {
    const owned = makeClient({ data: { id: "attempt-1" }, error: null });
    await expect(ownsAttempt(owned.client, "attempt-1")).resolves.toBe(true);

    const notOwned = makeClient({ data: null, error: null });
    await expect(ownsAttempt(notOwned.client, "attempt-1")).resolves.toBe(false);

    const failed = makeClient({ data: null, error: { message: "timeout" } });
    await expect(ownsAttempt(failed.client, "attempt-1")).resolves.toBe(false);
  });
});

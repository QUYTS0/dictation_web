/**
 * Phase 6 correction pass on real PostgreSQL (040):
 *   - local-day attribution of activity (streak days) from the IANA
 *     timezone each activity batch captured, with the documented UTC
 *     fallback for history and for batches without a valid timezone;
 *   - Library membership after a deliberate removal: mode switches,
 *     practice, Listening, reads and the reconciliation never restore it;
 *     only an explicit Add does — also under concurrent requests.
 *
 * Same upgrade path as phase6-library: 001–038, activated cutover, 039
 * (with pre-040 activity seeded), then 040. Skipped unless LOCALDB_ADMIN_URL.
 */
import { randomUUID } from "crypto";
import {
  HAS_LOCALDB,
  applyMigration,
  asRole,
  backendPid,
  beginAs,
  createTestDb,
  createUser,
  errorOf,
  publishTranscript,
  rpcAs,
  runCutover,
  waitUntilBlocked,
  type PgClient,
  type TestDb,
} from "./localdb/harness";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[phase6-corrections] skipped — LOCALDB_ADMIN_URL not set");

type Json = Record<string, unknown> & { [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Days {
  days: string[];
  utcFallbackDays: string[];
}

const TEXTS = ["one two", "three four", "five six", "seven eight"];
const HCM = "Asia/Ho_Chi_Minh";
const NY = "America/New_York";

/** YYYY-MM-DD of an epoch second in an IANA zone (independent of PostgreSQL). */
const localDate = (epochSec: number, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epochSec * 1000));
const utcDate = (epochSec: number) => localDate(epochSec, "UTC");
const secondsSinceLocalMidnight = (epochSec: number, tz: string) => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(epochSec * 1000))
    .reduce<Record<string, number>>((acc, p) => (p.type === "literal" ? acc : { ...acc, [p.type]: Number(p.value) }), {});
  return parts.hour * 3600 + parts.minute * 60 + parts.second;
};
/** A zone whose local date differs from the UTC date right now (one of these always does). */
const zoneAheadOrBehindUtc = (now: number) =>
  ["Pacific/Kiritimati", "Pacific/Pago_Pago"].find((tz) => localDate(now, tz) !== utcDate(now))!;
/** A zone whose last local midnight was 2–20 hours ago (HCM when it fits). */
const zoneWithRecentMidnight = (now: number) => {
  const zones = [HCM, ...Array.from({ length: 27 }, (_, i) => i - 12).map((o) => (o === 0 ? "Etc/UTC" : `Etc/GMT${o > 0 ? "-" : "+"}${Math.abs(o)}`))];
  for (const tz of zones) {
    const since = secondsSinceLocalMidnight(now, tz);
    if (since >= 7200 && since <= 72000) return { tz, midnight: Math.floor(now - since) };
  }
  throw new Error("no zone found");
};

d("Phase 6 corrections — local-day streak attribution (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let historical: string;
  let historicalAt: number;

  const call = <T = Json>(user: string, sql: string, params: unknown[] = []) => rpcAs<T>(c, user, sql, params);
  const flush = (
    u: string,
    v: string,
    intervals: Array<{ start: number; end: number }>,
    tz: string | null,
    opts: { batch?: string; round?: string | null; age?: number } = {}
  ) =>
    call(u, "select fn_sync_study_activity('activity', $1, $2, $3, $4::jsonb, null, null, $5, $6)", [
      opts.batch ?? randomUUID(),
      v,
      opts.round ?? null,
      JSON.stringify(intervals),
      tz,
      opts.age ?? 0,
    ]);
  const days = (u: string) => call<Days>(u, "select fn_activity_days()");
  const batchRow = async (batch: string) =>
    (
      await c.query(
        "select client_timezone, day_basis, array_to_json(activity_dates) as dates from activity_flush_log where flush_batch_id = $1",
        [batch]
      )
    ).rows[0] as { client_timezone: string | null; day_basis: string | null; dates: string[] | null };
  const ownerDates = async (intervals: Array<{ start: number; end: number }>, tz: string) =>
    (await c.query("select array_to_json(fn_local_activity_dates($1::jsonb, $2)) as d", [JSON.stringify(intervals), tz])).rows[0].d as string[];
  const at = (iso: string) => Date.parse(iso) / 1000;
  const nowSec = () => Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    db = await createTestDb("phase6tz", 38);
    c = await db.connect();
    await runCutover(c, "activated");
    await applyMigration(c, 39);
    // Activity recorded BEFORE 040: 039 fingerprinted the timezone but kept nothing.
    historical = await createUser(c);
    historicalAt = nowSec() - 300;
    await rpcAs(c, historical, "select fn_sync_study_activity('activity', $1, 'vidHist', null, $2::jsonb, null, null, $3, 0)", [
      randomUUID(),
      JSON.stringify([{ start: historicalAt, end: historicalAt + 60 }]),
      HCM,
    ]);
    await applyMigration(c, 40);
  }, 240_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("Asia/Ho_Chi_Minh 00:30 belongs to its local date; before/after/across local midnight; end exactly at midnight", async () => {
    // 2026-10-02 00:30 in Vietnam = 2026-10-01 17:30 UTC.
    expect(await ownerDates([{ start: at("2026-10-01T17:30:00Z"), end: at("2026-10-01T17:40:00Z") }], HCM)).toEqual(["2026-10-02"]);
    expect(await ownerDates([{ start: at("2026-10-01T17:30:00Z"), end: at("2026-10-01T17:40:00Z") }], "UTC")).toEqual(["2026-10-01"]);
    // 23:50–23:59 local (just before midnight) and 00:00:30–00:05 (just after).
    expect(await ownerDates([{ start: at("2026-10-01T16:50:00Z"), end: at("2026-10-01T16:59:00Z") }], HCM)).toEqual(["2026-10-01"]);
    expect(await ownerDates([{ start: at("2026-10-01T17:00:30Z"), end: at("2026-10-01T17:05:00Z") }], HCM)).toEqual(["2026-10-02"]);
    // Engaged across midnight → both dates; ending exactly AT midnight → only the first (half-open).
    expect(await ownerDates([{ start: at("2026-10-01T16:55:00Z"), end: at("2026-10-01T17:05:00Z") }], HCM)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(await ownerDates([{ start: at("2026-10-01T16:50:00Z"), end: at("2026-10-01T17:00:00Z") }], HCM)).toEqual(["2026-10-01"]);
    // Two engaged spans with IDLE time across midnight between them: only the
    // dates the spans touch — and a single span before midnight dates one day.
    expect(await ownerDates([{ start: at("2026-10-01T16:00:00Z"), end: at("2026-10-01T16:10:00Z") }], HCM)).toEqual(["2026-10-01"]);
  });

  it("DST: America/New_York days are found by the tz database, not a fixed offset or 24-hour days", async () => {
    // 2026-11-01 ends DST. 2026-11-02 04:30Z is 23:30 EST on Nov 1 (a fixed EDT offset would say Nov 2).
    expect(await ownerDates([{ start: at("2026-11-02T04:30:00Z"), end: at("2026-11-02T04:50:00Z") }], NY)).toEqual(["2026-11-01"]);
    expect(await ownerDates([{ start: at("2026-11-02T04:55:00Z"), end: at("2026-11-02T05:05:00Z") }], NY)).toEqual(["2026-11-01", "2026-11-02"]);
    // 2026-03-08 has 23 hours: local midnight after it is 04:00Z, not 05:00Z.
    expect(await ownerDates([{ start: at("2026-03-09T03:55:00Z"), end: at("2026-03-09T04:05:00Z") }], NY)).toEqual(["2026-03-08", "2026-03-09"]);
    expect(await ownerDates([{ start: at("2026-03-09T04:30:00Z"), end: at("2026-03-09T04:40:00Z") }], NY)).toEqual(["2026-03-09"]);
  });

  it("time zone identifiers are validated (IANA names only)", async () => {
    const valid = async (tz: string | null) => (await c.query("select fn_valid_time_zone($1) as ok", [tz])).rows[0].ok as boolean;
    for (const tz of [HCM, NY, "UTC", "Europe/London", "Etc/GMT-7"]) expect([tz, await valid(tz)]).toEqual([tz, true]);
    for (const tz of [null, "", "Mars/Olympus", "UTC+7", "+07", "PST", "EST5EDT", "localtime", "posixrules", "Asia/Ho_Chi_Minh'; --", "x".repeat(65)]) {
      expect([tz, await valid(tz)]).toEqual([tz, false]);
    }
  });

  it("a flush is dated where the activity happened in its captured zone — not UTC; several events on one date count once", async () => {
    const u = await createUser(c);
    const now = nowSec();
    const tz = zoneAheadOrBehindUtc(now);
    await publishTranscript(c, "vidTz", TEXTS);
    const round = (await call(u, "select fn_create_or_get_active_round('vidTz')")).roundId as string;
    const b1 = randomUUID();
    expect(await flush(u, "vidTz", [{ start: now - 200, end: now - 150 }], tz, { batch: b1, round })).toMatchObject({ processed: true });
    await flush(u, "vidTz", [{ start: now - 100, end: now - 60 }], tz, { round });
    // A Dictation answer in the same study session is dated in that session's zone too.
    await call(u, "select fn_record_dictation_attempt($1, 'vidTz', 0, $2, 'one two', 'relaxed', null, null, 0::smallint)", [round, randomUUID()]);
    await call(u, "select fn_record_shadowing_attempt($1, 'vidTz', 1, $2, 2)", [round, randomUUID()]);

    expect(await batchRow(b1)).toEqual({ client_timezone: tz, day_basis: "local", dates: [localDate(now - 200, tz)] });
    const r = await days(u);
    const expected = [...new Set([now - 200, now - 100, nowSec()].map((t) => localDate(t, tz)))].sort().reverse();
    expect(r.days).toEqual(expected);
    expect(r.days).not.toContain(utcDate(now));
    expect(r.utcFallbackDays).toEqual([]);
  });

  it("a delayed batch is dated by when it was observed; a retry after midnight keeps its dates; idle time across midnight adds no day", async () => {
    const now = nowSec();
    const { tz, midnight } = zoneWithRecentMidnight(now);
    const before = localDate(midnight - 1, tz);
    const today = localDate(now, tz);
    expect(before).not.toBe(today);

    // Idle across midnight: the only engaged span ended before local midnight;
    // the session is touched now (after midnight) but no new day appears.
    const idle = await createUser(c);
    await flush(idle, "vidIdle", [{ start: midnight - 900, end: midnight - 600 }], tz);
    expect((await days(idle)).days).toEqual([before]);

    // Delayed: a session exists today; a batch observed before midnight
    // arrives now (late attribution, Phase 5) and is dated BEFORE midnight.
    const u = await createUser(c);
    await flush(u, "vidLate", [{ start: now - 120, end: now - 60 }], tz);
    const late = randomUUID();
    const lateIntervals = [{ start: midnight - 600, end: midnight - 300 }];
    expect(await flush(u, "vidLate", lateIntervals, tz, { batch: late, age: now - midnight + 300 })).toMatchObject({
      processed: true,
      attribution: "late",
    });
    expect((await batchRow(late)).dates).toEqual([before]);
    expect((await days(u)).days).toEqual([today, before]);

    // Retry of the SAME sealed batch (after midnight): a no-op — the stored
    // dates are not recomputed. A changed timezone is a different payload
    // and is refused; the original batch is untouched.
    expect(await flush(u, "vidLate", lateIntervals, tz, { batch: late, age: now - midnight + 300 })).toMatchObject({
      processed: false,
      attribution: "replay",
    });
    const otherTz = tz === "UTC" || tz === "Etc/UTC" ? HCM : "UTC";
    expect((await errorOf(flush(u, "vidLate", lateIntervals, otherTz, { batch: late, age: now - midnight + 300 })))?.message).toMatch(
      /flush_batch_id_reused_with_different_payload/
    );
    expect(await batchRow(late)).toEqual({ client_timezone: tz, day_basis: "local", dates: [before] });
    expect(await c.query("select count(*)::int n from activity_flush_log where flush_batch_id = $1", [late]).then((r) => r.rows[0].n)).toBe(1);
    expect((await days(u)).days).toEqual([today, before]);
  });

  it("missing or invalid timezone: the batch is kept and dated in UTC, marked utc_fallback; an over-long value is refused", async () => {
    const now = nowSec();
    for (const tz of [null, "Mars/Olympus", "UTC+7"]) {
      const u = await createUser(c);
      const batch = randomUUID();
      expect(await flush(u, "vidNoTz", [{ start: now - 100, end: now - 50 }], tz, { batch })).toMatchObject({ processed: true });
      expect(await batchRow(batch)).toEqual({ client_timezone: null, day_basis: "utc_fallback", dates: [utcDate(now - 100)] });
      expect(await days(u)).toEqual({ days: [utcDate(now - 100)], utcFallbackDays: [utcDate(now - 100)] });
    }
    const u = await createUser(c);
    expect((await errorOf(flush(u, "vidNoTz", [{ start: now - 100, end: now - 50 }], "x".repeat(65))))?.message).toMatch(
      /invalid_interval_payload/
    );
  });

  it("history: activity recorded before 040 keeps its UTC day, labeled as fallback; nothing is re-bucketed by a later zone", async () => {
    expect((await c.query("select count(*)::int n from activity_flush_log l join study_sessions s on s.id = l.study_session_id where s.user_id = $1 and l.activity_dates is null", [historical])).rows[0].n).toBe(1);
    expect(await days(historical)).toEqual({ days: [utcDate(historicalAt)], utcFallbackDays: [utcDate(historicalAt)] });
    // New activity in another session with a zone dates locally and does not touch the old day.
    const tz = zoneAheadOrBehindUtc(nowSec());
    await flush(historical, "vidHist2", [{ start: nowSec() - 40, end: nowSec() - 20 }], tz);
    const r = await days(historical);
    expect(r.days).toEqual(expect.arrayContaining([utcDate(historicalAt), localDate(nowSec(), tz)]));
    expect(r.utcFallbackDays).toEqual(localDate(nowSec(), tz) === utcDate(historicalAt) ? [] : [utcDate(historicalAt)]);
  });

  it("reading Dashboard, a report, History or the Library and switching modes create no activity or day", async () => {
    const u = await createUser(c);
    await publishTranscript(c, "vidRead", TEXTS);
    await call(u, "select fn_library_add_video('vidRead', true)");
    const round = (await call(u, "select fn_create_or_get_active_round('vidRead')")).roundId as string;
    const snapshot = async () =>
      (
        await c.query(
          `select (select count(*) from study_sessions where user_id = $1)::int s,
                  (select count(*) from activity_flush_log l join study_sessions s on s.id = l.study_session_id where s.user_id = $1)::int f`,
          [u]
        )
      ).rows[0];
    const before = await snapshot();
    await call(u, "select fn_dashboard_summary()");
    await call(u, "select fn_round_report($1)", [round]);
    await call(u, "select fn_history_sessions(20, null, null, null)");
    await call(u, "select fn_video_library(20, 0, 'all')");
    await call(u, "select fn_set_video_last_mode('vidRead', 'listening')");
    await call(u, "select fn_set_video_last_mode('vidRead', 'dictation')");
    expect(await snapshot()).toEqual(before);
    expect(await days(u)).toEqual({ days: [], utcFallbackDays: [] });
  });
});

d("Phase 6 corrections — Library membership after removal (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let c2: PgClient;
  let observer: PgClient;
  let u: string;
  let other: string;

  const call = <T = Json>(user: string, sql: string, params: unknown[] = []) => rpcAs<T>(c, user, sql, params);
  const add = (user: string, v: string, explicit = true) => call(user, "select fn_library_add_video($1, $2)", [v, explicit]);
  const remove = (user: string, v: string) => call(user, "select fn_library_remove_video($1)", [v]);
  const setMode = (user: string, v: string, mode: string) => call(user, "select fn_set_video_last_mode($1, $2)", [v, mode]);
  const lastMode = (user: string, v: string) => call<string | null>(user, "select fn_video_last_mode($1)", [v]);
  const cards = async (user: string, v: string) =>
    ((await call(user, "select fn_video_library(50, 0, 'all')")).items as Json[]).filter((i) => i.videoId === v);
  const marker = async (user: string, v: string) =>
    (await c.query("select last_mode, removed_at from user_video_removals where user_id = $1 and youtube_video_id = $2", [user, v])).rows[0] as
      | { last_mode: string | null; removed_at: Date }
      | undefined;
  const memberships = async (user: string, v: string) =>
    Number((await c.query("select count(*) n from user_videos where user_id = $1 and youtube_video_id = $2", [user, v])).rows[0].n);

  beforeAll(async () => {
    db = await createTestDb("phase6mem", 38);
    c = await db.connect();
    c2 = await db.connect();
    observer = await db.connect();
    await runCutover(c, "activated");
    await applyMigration(c, 39);
    await applyMigration(c, 40);
    u = await createUser(c);
    other = await createUser(c);
  }, 240_000);
  afterAll(async () => {
    await c?.end();
    await c2?.end();
    await observer?.end();
    await db?.drop();
  });

  it("1–8: after removal nothing but an explicit Add restores the card; the mode is kept; history is intact; Add is idempotent", async () => {
    const tr = await publishTranscript(c, "vidR", TEXTS);
    await add(u, "vidR");
    const round = (await call(u, "select fn_create_or_get_active_round('vidR')")).roundId as string;
    await call(u, "select fn_record_dictation_attempt($1, 'vidR', 0, $2, 'one two', 'relaxed', null, null, 0::smallint)", [round, randomUUID()]);
    await setMode(u, "vidR", "dictation");

    expect(await remove(u, "vidR")).toMatchObject({ removed: true });
    expect(await cards(u, "vidR")).toHaveLength(0);
    expect(await marker(u, "vidR")).toMatchObject({ last_mode: "dictation" });

    // 1. Open History / the report / the practice page's reads, then switch mode.
    await call(u, "select fn_history_sessions(20, null, null, 'vidR')");
    await call(u, "select fn_round_report($1)", [round]);
    await call(u, "select fn_my_round_progress($1)", [round]);
    expect(await setMode(u, "vidR", "shadowing")).toMatchObject({ lastMode: "shadowing", added: false, inLibrary: false });
    expect(await cards(u, "vidR")).toHaveLength(0);
    expect(await memberships(u, "vidR")).toBe(0);
    // 2. The mode persists on the removal marker.
    expect(await lastMode(u, "vidR")).toBe("shadowing");
    expect(await marker(u, "vidR")).toMatchObject({ last_mode: "shadowing" });

    // 3. Dictation submission (+ the routes' automatic first-use add).
    await call(u, "select fn_record_dictation_attempt($1, 'vidR', 1, $2, 'three four', 'relaxed', null, null, 0::smallint)", [round, randomUUID()]);
    expect(await add(u, "vidR", false)).toMatchObject({ added: false, suppressedByRemoval: true });
    // 4. Shadowing take.
    await call(u, "select fn_record_shadowing_attempt($1, 'vidR', 2, $2, 2)", [round, randomUUID()]);
    expect(await add(u, "vidR", false)).toMatchObject({ suppressedByRemoval: true });
    // 5. Listening flush (+ automatic add, as the Listening route does).
    await call(u, "select fn_sync_study_activity('listening', $1, 'vidR', $2, $3::jsonb, $4, 4, 'UTC', 0)", [
      randomUUID(),
      round,
      JSON.stringify([{ start: 0, end: 4 }]),
      tr,
    ]);
    expect(await add(u, "vidR", false)).toMatchObject({ suppressedByRemoval: true });
    expect(await cards(u, "vidR")).toHaveLength(0);
    // 6. Reconciliation respects the marker; the gap excludes removed videos.
    const rec = (await c.query("select fn_phase6_reconcile_membership() as r")).rows[0].r;
    expect(rec.skippedRemoved).toBeGreaterThanOrEqual(1);
    expect(await cards(u, "vidR")).toHaveLength(0);
    expect(Number((await c.query("select fn_phase6_membership_gap() as n")).rows[0].n)).toBe(0);
    expect(await marker(u, "vidR")).toBeDefined();

    // 7. Explicit Add back: one card, new added_at, the kept mode, all history.
    const removedAt = (await marker(u, "vidR"))!.removed_at;
    const back = await add(u, "vidR");
    expect(back).toMatchObject({ added: true, restoredFromRemoval: true });
    expect(Date.parse(back.addedAt as string)).toBeGreaterThanOrEqual(removedAt.getTime());
    expect(await marker(u, "vidR")).toBeUndefined();
    const restored = await cards(u, "vidR");
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ lastMode: "shadowing", state: "in_progress" });
    expect(restored[0].round).toMatchObject({ roundId: round });
    expect(restored[0].round.progress.coveredSentences.overall).toBe(3);
    expect(restored[0].listening).toMatchObject({ hasHistory: true });
    // 8. Repeated Add: no duplicate, added_at unchanged.
    expect(await add(u, "vidR")).toMatchObject({ added: false, addedAt: back.addedAt, restoredFromRemoval: false });
    expect(await memberships(u, "vidR")).toBe(1);
  });

  it("9: a never-removed video still joins the Library on genuine first use (and a mode switch on it keeps the established add)", async () => {
    await publishTranscript(c, "vidFresh", TEXTS);
    expect(await add(u, "vidFresh", false)).toMatchObject({ added: true });
    expect(await cards(u, "vidFresh")).toHaveLength(1);
    expect(await setMode(u, "vidByLink", "listening")).toMatchObject({ added: true, inLibrary: true });
    expect(await cards(u, "vidByLink")).toHaveLength(1);
    expect(await setMode(u, "vidByLink", "shadowing")).toMatchObject({ added: false, inLibrary: true });
  });

  it("10: a removal racing a delayed mode switch, automatic add or reconciliation always wins", async () => {
    const race = async (video: string, late: () => Promise<unknown>, latePid: () => Promise<number>) => {
      await add(u, video);
      await beginAs(c2, "authenticated", u);
      await c2.query("select fn_library_remove_video($1)", [video]); // holds the entry lock, uncommitted
      const pid = await latePid();
      const pending = late();
      await waitUntilBlocked(observer, pid);
      await c2.query("commit");
      await pending;
      expect(await cards(u, video)).toHaveLength(0);
      expect(await memberships(u, video)).toBe(0);
      expect(await marker(u, video)).toBeDefined();
    };
    const cPid = () => backendPid(c);
    await race("vidRace1", () => setMode(u, "vidRace1", "listening"), cPid);
    expect(await lastMode(u, "vidRace1")).toBe("listening");
    await race("vidRace2", () => add(u, "vidRace2", false), cPid);
    // The reconciliation (owner) waits for the uncommitted removal, then sees its marker.
    await publishTranscript(c, "vidRace3", TEXTS);
    await call(u, "select fn_create_or_get_active_round('vidRace3')");
    await race("vidRace3", () => c.query("select fn_phase6_reconcile_membership()"), cPid);

    // Reverse order: a mode switch holds the lock first; the removal waits,
    // then removes and keeps the switched mode.
    await add(u, "vidRace4");
    await beginAs(c2, "authenticated", u);
    await c2.query("select fn_set_video_last_mode('vidRace4', 'shadowing')");
    const pid = await backendPid(c);
    const pending = remove(u, "vidRace4");
    await waitUntilBlocked(observer, pid);
    await c2.query("commit");
    expect(await pending).toMatchObject({ removed: true });
    expect(await cards(u, "vidRace4")).toHaveLength(0);
    expect(await marker(u, "vidRace4")).toMatchObject({ last_mode: "shadowing" });
  });

  it("11: removal markers and membership are per account", async () => {
    await add(u, "vidShared");
    await add(other, "vidShared");
    await remove(u, "vidShared");
    expect(await cards(other, "vidShared")).toHaveLength(1);
    expect(await setMode(other, "vidShared", "listening")).toMatchObject({ inLibrary: true });
    expect(await add(other, "vidShared", false)).toMatchObject({ added: false });
    expect(await cards(u, "vidShared")).toHaveLength(0);
    expect(await lastMode(other, "vidShared")).toBe("listening");
    expect(await lastMode(u, "vidShared")).toBeNull();
    // Another account's marker is invisible and cannot be written directly.
    const seen = await asRole(c, "authenticated", other, () =>
      c.query("select count(*)::int n from user_video_removals where youtube_video_id = 'vidShared'")
    );
    expect(seen.rows[0].n).toBe(0);
    const err = await errorOf(
      asRole(c, "authenticated", other, () => c.query("delete from user_video_removals where youtube_video_id = 'vidShared'"))
    );
    expect(err?.message).toMatch(/permission denied/);
    expect(await marker(u, "vidShared")).toBeDefined();
  });
});

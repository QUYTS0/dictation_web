import { computeStreakFromDays, isValidTimeZone, localDayKey, previousDayKey, streakDayKeys } from "@/lib/utils/streak";

const HCM = "Asia/Ho_Chi_Minh";
const NY = "America/New_York";

describe("localDayKey — the viewer's local calendar date", () => {
  it("00:30 on Oct 2 in Vietnam is Oct 2 (UTC still says Oct 1)", () => {
    const instant = new Date("2026-10-01T17:30:00Z");
    expect(localDayKey(instant, HCM)).toBe("2026-10-02");
    expect(localDayKey(instant, "UTC")).toBe("2026-10-01");
  });

  it("just before and just after local midnight", () => {
    expect(localDayKey(new Date("2026-10-01T16:59:59Z"), HCM)).toBe("2026-10-01");
    expect(localDayKey(new Date("2026-10-01T17:00:00Z"), HCM)).toBe("2026-10-02");
  });

  it("DST: New York's local date comes from the tz database", () => {
    expect(localDayKey(new Date("2026-11-02T04:30:00Z"), NY)).toBe("2026-11-01"); // 23:30 EST
    expect(localDayKey(new Date("2026-03-09T03:30:00Z"), NY)).toBe("2026-03-08"); // 23:30 EDT
  });
});

describe("previousDayKey — calendar arithmetic, not 24-hour steps", () => {
  it("handles month/year ends, leap days and DST dates alike", () => {
    expect(previousDayKey("2026-10-01")).toBe("2026-09-30");
    expect(previousDayKey("2026-01-01")).toBe("2025-12-31");
    expect(previousDayKey("2028-03-01")).toBe("2028-02-29");
    expect(previousDayKey("2026-03-09")).toBe("2026-03-08"); // after the 23-hour day in New York
    expect(previousDayKey("2026-11-02")).toBe("2026-11-01"); // after the 25-hour day
  });
});

describe("computeStreakFromDays", () => {
  const today = "2026-10-02";

  it("no activity → 0; only today → 1", () => {
    expect(computeStreakFromDays([], today)).toBe(0);
    expect(computeStreakFromDays([today], today)).toBe(1);
  });

  it("consecutive days ending today", () => {
    expect(computeStreakFromDays(["2026-10-02", "2026-10-01", "2026-09-30"], today)).toBe(3);
  });

  it("latest activity yesterday (local) keeps the streak alive", () => {
    expect(computeStreakFromDays(["2026-10-01", "2026-09-30"], today)).toBe(2);
  });

  it("an actual missing day breaks it; last activity two days ago → 0", () => {
    expect(computeStreakFromDays(["2026-10-02", "2026-10-01", "2026-09-29"], today)).toBe(2);
    expect(computeStreakFromDays(["2026-09-30"], today)).toBe(0);
  });

  it("several events on one date are one day", () => {
    expect(computeStreakFromDays(["2026-10-02", "2026-10-02", "2026-10-01", "2026-10-01"], today)).toBe(2);
  });

  it("across the DST change in New York (23- and 25-hour days) nothing is skipped or doubled", () => {
    expect(computeStreakFromDays(["2026-03-09", "2026-03-08", "2026-03-07"], "2026-03-09")).toBe(3);
    expect(computeStreakFromDays(["2026-11-02", "2026-11-01", "2026-10-31"], "2026-11-02")).toBe(3);
  });

  it("Vietnam: practice at 00:30 local on Oct 2 continues an Oct 1 streak (UTC would see two Oct 1 events)", () => {
    const days = [localDayKey(new Date("2026-10-01T17:30:00Z"), HCM), localDayKey(new Date("2026-10-01T03:00:00Z"), HCM)];
    expect(days).toEqual(["2026-10-02", "2026-10-01"]);
    expect(computeStreakFromDays(days, "2026-10-02")).toBe(2);
  });

  it("streakDayKeys lists exactly the counted dates", () => {
    expect(streakDayKeys(["2026-10-01", "2026-09-30", "2026-09-28"], today)).toEqual(["2026-10-01", "2026-09-30"]);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names, refuses everything else", () => {
    for (const tz of [HCM, NY, "UTC", "Etc/GMT-7"]) expect([tz, isValidTimeZone(tz)]).toEqual([tz, true]);
    for (const tz of [null, undefined, "", "Mars/Olympus", "+07:00", "UTC+7", "PST", "EST5EDT", "localtime", "x".repeat(65), 7]) {
      expect([tz, isValidTimeZone(tz)]).toEqual([tz, false]);
    }
  });
});

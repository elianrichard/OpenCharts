import { describe, expect, it } from "vitest";
import {
  addDays,
  alpacaBarOpenMs,
  chartSafeTickTime,
  etDateKey,
  etMidnightMs,
  marketSession,
  scanEpoch,
  TIMEFRAME_MS,
} from "../time.ts";

const at = (iso: string) => Date.parse(iso);

/** ChartPanel's tick bucketing (src/pages/trading/utils.ts getCandleBucketTime), in ms. */
const chartBucket = (ms: number, size: number) => Math.floor(ms / size) * size;

describe("New York calendar", () => {
  it("finds midnight in winter and summer", () => {
    expect(etMidnightMs("2026-11-10")).toBe(at("2026-11-10T05:00:00Z"));
    expect(etMidnightMs("2026-07-01")).toBe(at("2026-07-01T04:00:00Z"));
  });

  it("finds midnight on both DST switch days", () => {
    expect(etMidnightMs("2026-03-08")).toBe(at("2026-03-08T05:00:00Z"));
    expect(etMidnightMs("2026-11-01")).toBe(at("2026-11-01T04:00:00Z"));
  });

  it("dates by New York, not UTC", () => {
    expect(etDateKey(at("2026-11-12T03:00:00Z"))).toBe("2026-11-11");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it.each([
    ["2026-11-12T08:59:00Z", "closed"], // 03:59 ET
    ["2026-11-12T09:00:00Z", "pre"], // 04:00
    ["2026-11-12T14:29:59Z", "pre"], // 09:29:59
    ["2026-11-12T14:30:00Z", "regular"], // 09:30
    ["2026-11-12T20:59:59Z", "regular"], // 15:59:59
    ["2026-11-12T21:00:00Z", "post"], // 16:00
    ["2026-11-13T00:59:00Z", "post"], // 19:59
    ["2026-11-13T01:00:00Z", "closed"], // 20:00
    ["2026-07-01T13:30:00Z", "regular"], // 09:30 EDT
    ["2026-11-14T15:00:00Z", "closed"], // Saturday
  ])("%s is %s", (iso, session) => {
    expect(marketSession(at(iso))).toBe(session);
  });
});

describe("Alpaca bar opens (as observed on the live API)", () => {
  it("anchors daily bars at 00:00 New York", () => {
    expect(alpacaBarOpenMs("1d", at("2026-11-10T20:00:00Z"))).toBe(at("2026-11-10T05:00:00Z"));
    // 21:30 ET is still the same New York day though UTC has rolled over.
    expect(alpacaBarOpenMs("1d", at("2026-11-11T02:30:00Z"))).toBe(at("2026-11-10T05:00:00Z"));
  });

  it("anchors weekly bars at Monday 00:00 New York", () => {
    expect(alpacaBarOpenMs("1w", at("2026-11-12T15:00:00Z"))).toBe(at("2026-11-09T05:00:00Z"));
    expect(alpacaBarOpenMs("1w", at("2026-10-30T15:00:00Z"))).toBe(at("2026-10-26T04:00:00Z"));
    expect(alpacaBarOpenMs("1w", at("2026-11-15T15:00:00Z"))).toBe(at("2026-11-09T05:00:00Z")); // Sunday
  });

  it("puts intraday bars, 4h included, on the UTC grid", () => {
    expect(alpacaBarOpenMs("4h", at("2026-11-10T14:31:00Z"))).toBe(at("2026-11-10T12:00:00Z"));
    expect(alpacaBarOpenMs("5m", at("2026-11-10T14:31:10Z"))).toBe(at("2026-11-10T14:30:00Z"));
  });
});

describe("chartSafeTickTime", () => {
  const week = TIMEFRAME_MS["1w"];
  const day = TIMEFRAME_MS["1d"];

  it("keeps a Thursday tick off a phantom weekly candle", () => {
    const barOpen = at("2026-11-09T05:00:00Z"); // Monday
    const thursday = at("2026-11-12T15:00:00Z");
    // ChartPanel's weekly buckets start on Thursdays (the epoch was one).
    expect(chartBucket(thursday, week)).toBeGreaterThan(barOpen);
    const safe = chartSafeTickTime(thursday, "1w", barOpen);
    expect(chartBucket(safe, week)).toBeLessThanOrEqual(barOpen);
    expect(safe).toBe(at("2026-11-11T23:59:59.999Z"));
  });

  it("leaves a mid-week tick alone", () => {
    const tuesday = at("2026-11-10T15:00:00Z");
    expect(chartSafeTickTime(tuesday, "1w", at("2026-11-09T05:00:00Z"))).toBe(tuesday);
  });

  it("holds a winter post-market tick on the daily bar's UTC day", () => {
    const barOpen = at("2026-11-12T05:00:00Z");
    const late = at("2026-11-13T00:30:00Z"); // 19:30 ET
    const safe = chartSafeTickTime(late, "1d", barOpen);
    expect(chartBucket(safe, day)).toBeLessThanOrEqual(barOpen);
    // ...and a regular-hours tick keeps its time.
    expect(chartSafeTickTime(at("2026-11-12T15:00:00Z"), "1d", barOpen)).toBe(at("2026-11-12T15:00:00Z"));
  });

  it("never touches aligned intraday timeframes", () => {
    const t = at("2026-11-12T15:07:00Z");
    expect(chartSafeTickTime(t, "1m", at("2026-11-12T15:00:00Z"))).toBe(t);
    expect(chartSafeTickTime(t, "4h", at("2026-11-12T12:00:00Z"))).toBe(t);
  });
});

describe("scanEpoch", () => {
  it("rolls at 16:20 ET on weekdays and at midnight", () => {
    expect(scanEpoch(at("2026-11-12T21:19:00Z"))).toBe("2026-11-12");
    expect(scanEpoch(at("2026-11-12T21:20:00Z"))).toBe("2026-11-12+close");
    expect(scanEpoch(at("2026-11-13T04:59:00Z"))).toBe("2026-11-12+close");
    expect(scanEpoch(at("2026-11-14T22:00:00Z"))).toBe("2026-11-14");
  });
});

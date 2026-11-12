import { describe, expect, it } from "vitest";
import type { Bar } from "../../types.ts";
import type { RawSnapshot } from "../alpaca.ts";
import { averageVolume, buildSnapshot, pickQuote, sessionCloseMs } from "../snapshot.ts";

const at = (iso: string) => Date.parse(iso);
const daily = (date: string, o: number, h: number, l: number, c: number, v: number) => ({
  t: `${date}T05:00:00Z`,
  o,
  h,
  l,
  c,
  v,
});

// Shapes and values recorded from the live API (AAPL, 2026-11-12 07:14 ET).
const IEX_AFTER_CLOSE: RawSnapshot = {
  latestTrade: { t: "2026-11-11T20:59:59.785Z", p: 355.78 },
  // IEX's off-hours quote is a placeholder, nowhere near the market.
  latestQuote: { t: "2026-11-11T21:00:00.000Z", bp: 331.91, ap: 366.91 },
  dailyBar: daily("2026-11-11", 349.535, 355.9, 349.325, 355.78, 1_133_672),
  prevDailyBar: daily("2026-11-10", 351.435, 353.785, 346.47, 348.49, 1_256_844),
};
const SIP_PREMARKET: RawSnapshot = {
  latestTrade: { t: "2026-11-12T11:58:24.329Z", p: 356.2 },
  latestQuote: { t: "2026-11-12T11:58:40.080Z", bp: 356, ap: 356.4 },
  dailyBar: daily("2026-11-11", 349.545, 355.91, 349.325, 355.63, 34_609_420),
  prevDailyBar: daily("2026-11-10", 351.35, 353.87, 346.4605, 348.51, 29_910_514),
};

describe("buildSnapshot", () => {
  it("pre-market: regular close as the price, the early trade as extended", () => {
    const s = buildSnapshot({
      symbol: "AAPL",
      iex: IEX_AFTER_CLOSE,
      sip: SIP_PREMARKET,
      nowMs: at("2026-11-12T12:14:00Z"),
      avgVolume30: 40_000_000,
    });
    expect(s).toMatchObject({
      symbol: "AAPL",
      last: 355.63,
      lastTime: sessionCloseMs("2026-11-11"),
      prevClose: 348.51,
      change: 7.12,
      open: 349.545,
      high: 355.91,
      low: 349.325,
      volume: 34_609_420,
      avgVolume30: 40_000_000,
      // IEX's placeholder quote is skipped for delayed SIP's real one.
      bid: 356,
      ask: 356.4,
    });
    expect(s.changePct).toBeCloseTo(2.043, 3);
    expect(s.extended).toEqual({
      price: 356.2,
      change: 0.57,
      changePct: expect.closeTo(0.1603, 3),
      session: "pre",
      time: at("2026-11-12T11:58:24.329Z"),
    });
  });

  it("regular session: live IEX trade against yesterday's close, range stretched", () => {
    const s = buildSnapshot({
      symbol: "AAPL",
      iex: {
        latestTrade: { t: "2026-11-12T14:59:58Z", p: 357.1 },
        latestQuote: { t: "2026-11-12T14:59:58Z", bp: 357.05, ap: 357.12 },
        dailyBar: daily("2026-11-12", 356.4, 357.05, 355.95, 357.1, 80_000),
      },
      sip: {
        latestTrade: { t: "2026-11-12T14:44:00Z", p: 356.8 },
        dailyBar: daily("2026-11-12", 356.5, 357.0, 355.9, 356.8, 5_000_000),
        prevDailyBar: daily("2026-11-11", 349.545, 355.91, 349.325, 355.63, 34_609_420),
      },
      nowMs: at("2026-11-12T15:00:00Z"),
      avgVolume30: null,
    });
    expect(s).toMatchObject({
      last: 357.1,
      lastTime: at("2026-11-12T14:59:58Z"),
      prevClose: 355.63,
      open: 356.5,
      high: 357.1,
      low: 355.9,
      volume: 5_000_000,
      bid: 357.05,
      ask: 357.12,
      extended: null,
    });
    expect(s.change).toBeCloseTo(1.47, 6);
  });

  it("first minutes of the session: IEX has rolled over, delayed SIP has not", () => {
    const s = buildSnapshot({
      symbol: "AAPL",
      iex: {
        latestTrade: { t: "2026-11-12T14:34:59Z", p: 357 },
        dailyBar: daily("2026-11-12", 356.6, 357.2, 356.5, 357, 40_000),
        prevDailyBar: daily("2026-11-11", 349.535, 355.9, 349.325, 355.78, 1_133_672),
      },
      sip: { ...SIP_PREMARKET, latestTrade: { t: "2026-11-12T14:19:00Z", p: 356.4 } },
      nowMs: at("2026-11-12T14:35:00Z"),
      avgVolume30: null,
    });
    expect(s.last).toBe(357);
    // The previous close is SIP's official one, not IEX's last print.
    expect(s.prevClose).toBe(355.63);
    expect(s.open).toBe(356.6);
    // IEX volume alone would understate the day.
    expect(s.volume).toBeNull();
    expect(s.extended).toBeNull();
  });

  it("just after the close: IEX's last print until delayed SIP has the closing auction", () => {
    const s = buildSnapshot({
      symbol: "AAPL",
      iex: { latestTrade: { t: "2026-11-12T20:59:59Z", p: 358 } },
      sip: {
        latestTrade: { t: "2026-11-12T20:50:00Z", p: 357.9 },
        dailyBar: daily("2026-11-12", 356.5, 358.4, 355.9, 357.9, 30_000_000),
        prevDailyBar: daily("2026-11-11", 349.545, 355.91, 349.325, 355.63, 34_609_420),
      },
      nowMs: at("2026-11-12T21:05:00Z"),
      avgVolume30: null,
    });
    expect(s.last).toBe(358);
    expect(s.extended).toBeNull();
  });

  it("post-market: the official close, and the late trade as extended", () => {
    const s = buildSnapshot({
      symbol: "AAPL",
      iex: { latestTrade: { t: "2026-11-12T20:59:59Z", p: 358 } },
      sip: {
        latestTrade: { t: "2026-11-12T22:14:00Z", p: 358.5 },
        dailyBar: daily("2026-11-12", 356.5, 358.4, 355.9, 358.2, 41_000_000),
        prevDailyBar: daily("2026-11-11", 349.545, 355.91, 349.325, 355.63, 34_609_420),
      },
      nowMs: at("2026-11-12T22:30:00Z"),
      avgVolume30: null,
    });
    expect(s.last).toBe(358.2);
    expect(s.lastTime).toBe(sessionCloseMs("2026-11-12"));
    expect(s.extended).toMatchObject({ price: 358.5, session: "post", time: at("2026-11-12T22:14:00Z") });
    expect(s.extended!.change).toBeCloseTo(0.3, 6);
  });

  it("weekend: Friday's close with Friday's post-market print", () => {
    const s = buildSnapshot({
      symbol: "AAPL",
      sip: {
        latestTrade: { t: "2026-11-14T00:55:00Z", p: 360.1 },
        dailyBar: daily("2026-11-13", 358, 360, 357, 359.5, 30_000_000),
        prevDailyBar: daily("2026-11-12", 356.5, 358.4, 355.9, 358.2, 41_000_000),
      },
      nowMs: at("2026-11-15T15:00:00Z"),
      avgVolume30: null,
    });
    expect(s).toMatchObject({ last: 359.5, prevClose: 358.2 });
    expect(s.extended).toMatchObject({ price: 360.1, session: "post" });
  });

  it("returns nulls rather than throwing on empty feeds", () => {
    const s = buildSnapshot({ symbol: "X", iex: null, sip: {}, nowMs: at("2026-11-12T15:00:00Z"), avgVolume30: null });
    expect(s).toMatchObject({ last: null, change: null, open: null, volume: null, bid: null, extended: null });
  });
});

describe("pickQuote", () => {
  it("takes the newest sane quote", () => {
    expect(
      pickQuote([
        { t: "2026-11-12T15:00:01Z", bp: 100, ap: 100.05 },
        { t: "2026-11-12T15:00:00Z", bp: 99.9, ap: 100 },
      ]),
    ).toEqual({ bid: 100, ask: 100.05 });
  });

  it("skips zero, crossed and absurdly wide quotes", () => {
    expect(pickQuote([{ t: "2026-11-12T15:00:00Z", bp: 0, ap: 100 }])).toBeNull();
    expect(pickQuote([{ t: "2026-11-12T15:00:00Z", bp: 101, ap: 100 }])).toBeNull();
    expect(pickQuote([{ t: "2026-11-12T15:00:00Z", bp: 90, ap: 110 }])).toBeNull();
    expect(pickQuote([null, undefined])).toBeNull();
  });
});

describe("averageVolume", () => {
  const day = (date: string, volume: number): Bar => ({
    time: Date.parse(`${date}T05:00:00Z`) / 1000,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume,
  });

  it("averages completed sessions only", () => {
    const bars = [day("2026-11-09", 100), day("2026-11-10", 200), day("2026-11-11", 300), day("2026-11-12", 9_999)];
    expect(averageVolume(bars, at("2026-11-12T18:00:00Z"), 3)).toBe(200);
    expect(averageVolume(bars, at("2026-11-12T18:00:00Z"), 4)).toBeNull();
    expect(averageVolume(null, 0)).toBeNull();
  });
});

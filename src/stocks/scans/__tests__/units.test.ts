/**
 * Edge cases the golden fixtures don't reach, plus the strategy-tester layer
 * (which has no Python counterpart beyond the trade replay). Expected values
 * marked "pandas" / "Python" were produced by the trading-script venv.
 */
import { describe, expect, it } from "vitest";
import type { Bar } from "../../types.ts";
import {
  DIV_STRATEGY_DEFAULTS,
  HOLD_BARS,
  STOCH_ARMED_LABEL,
  STOCH_CONFIRMED_LABEL,
  detectStochEvents,
  divergenceStrategy,
  dropForming,
  ema,
  listDivergences,
  pyRound,
  rollingMean,
  rollingSum,
  scanDivergence,
  scanStoch,
  stochStrategyMarkers,
} from "../index.ts";
import { fixtures } from "./fixtures.ts";

const fixture = (name: string) => {
  const f = fixtures.find((x) => x.case === name);
  if (!f) throw new Error(`missing fixture ${name}`);
  return f;
};

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);
const bar = (timeMs: number, close = 1): Bar => ({ time: timeMs / 1000, open: close, high: close, low: close, close, volume: 1 });

describe("pandas kernels", () => {
  const x = [NaN, 1, NaN, NaN, 3, 2, NaN, 5];

  it("ewm keeps pandas' NaN-gap weighting (pandas values)", () => {
    expect(ema(x, 4)).toEqual([NaN, 1, 1, 1, 2.298701298701299, 2.1792207792207794, 2.1792207792207794, 3.6638414217361586]);
    // com == 1 takes pandas' irregular-interval branch
    expect(ema(x, 3)).toEqual([NaN, 1, 1, 1, 2.75, 2.375, 2.375, 4.34375]);
  });

  it("rolling sum / mean match pandas' Kahan window (pandas values)", () => {
    const y = [0.1, 0.2, 0.3, 0.0, 0.0, 0.0, -0.1, 0.4];
    expect(rollingSum(y, 3)).toEqual([NaN, NaN, 0.6, 0.5, 0.29999999999999993, 0, -0.1, 0.30000000000000004]);
    expect(rollingMean(y, 3)).toEqual([
      NaN, NaN, 0.19999999999999998, 0.16666666666666666, 0.09999999999999998, 0, -0.03333333333333333,
      0.10000000000000002,
    ]);
    expect(rollingSum([1, NaN, 2, 3, 4], 2)).toEqual([NaN, NaN, NaN, 5, 7]);
  });
});

describe("pyRound", () => {
  it("matches Python round(x, 2), ties to even on the exact binary value", () => {
    const cases: [number, number][] = [
      [0.125, 0.12],
      [0.375, 0.38],
      [0.135, 0.14],
      [2.675, 2.67],
      [-0.125, -0.12],
      [0.005, 0.01],
      [0.015, 0.01],
      [0.285, 0.28],
      [1.005, 1.0],
    ];
    for (const [x, py] of cases) expect(pyRound(x, 2), String(x)).toBe(py);
    expect([0.5, 1.5, 2.5].map((v) => pyRound(v, 0))).toEqual([0, 2, 2]);
  });
});

describe("dropForming (Python drop_forming values)", () => {
  const cases: [string, number, number, "kept" | "dropped"][] = [
    ["1w", utc(2026, 11, 2, 5), utc(2026, 11, 6, 20, 59, 59), "dropped"],
    ["1w", utc(2026, 11, 2, 5), utc(2026, 11, 6, 21), "kept"],
    ["1w", utc(2026, 9, 8, 4), utc(2026, 9, 11, 20), "dropped"], // holiday week opening Tuesday
    ["1w", utc(2026, 9, 8, 4), utc(2026, 9, 11, 21), "kept"],
    ["1mo", utc(2026, 10, 1, 4), utc(2026, 10, 30, 20, 59, 59), "dropped"], // Oct 31 is a Saturday
    ["1mo", utc(2026, 10, 1, 4), utc(2026, 10, 30, 21), "kept"],
    ["1mo", utc(2026, 8, 1, 4), utc(2026, 8, 31, 20, 59, 59), "dropped"],
    ["1mo", utc(2026, 8, 1, 4), utc(2026, 8, 31, 21), "kept"],
    ["1mo", utc(2026, 5, 30, 4), utc(2026, 6, 30, 20, 59, 59), "dropped"], // BMonthEnd rolls into June
    ["1mo", utc(2026, 5, 30, 4), utc(2026, 6, 30, 21), "kept"],
    ["1d", utc(2026, 11, 2, 5), utc(2026, 11, 2, 6), "kept"],
  ];
  it.each(cases)("%s bar %s at now %s -> %s", (interval, barMs, nowMs, expected) => {
    const bars = [bar(barMs - 40 * 86400_000), bar(barMs, 2)];
    expect(dropForming(bars, interval, nowMs).length).toBe(expected === "kept" ? 2 : 1);
  });
});

describe("divergenceStrategy", () => {
  const avav = fixture("AVAV").daily!; // scan state EXIT
  const avgo = fixture("AVGO").daily!; // scan state HOLD
  const msftNew = fixture("MSFT_NEW").daily!; // scan state NEW

  it("labels markers like TradingView: 'Long +qty' / '-qty Time'", () => {
    const res = divergenceStrategy(avav.bars);
    const closed = res.trades.filter((t) => !t.open);
    expect(res.markers).toHaveLength(res.trades.length + closed.length);
    for (const t of res.trades) {
      expect(t.qty).toBeGreaterThan(0);
      expect(res.markers).toContainEqual({ time: t.entryTime, kind: "entry", label: `Long +${t.qty}` });
      if (t.exitTime !== null) {
        expect(res.markers).toContainEqual({ time: t.exitTime, kind: "exit", label: `-${t.qty} Time` });
      }
    }
  });

  it("agrees with the scan row on the open trade", () => {
    for (const fx of [avav, avgo]) {
      const row = scanDivergence("X", fx.bars);
      const open = divergenceStrategy(fx.bars).trades.at(-1)!;
      const last = fx.bars.length - 1;
      expect(open.open).toBe(true);
      expect(open.entryTime).toBe(row.entryDate);
      expect(open.entryPrice).toBe(row.entry);
      expect(open.markPrice).toBe(fx.bars[last]!.close);
      expect(open.bars).toBe(row.held! - 1);
      expect(open.exitTime).toBeNull();
    }
    // NEW: the signal fills at the next open, so it is not a trade yet
    const row = scanDivergence("MSFT", msftNew.bars);
    expect(row.state).toBe("NEW");
    const trades = divergenceStrategy(msftNew.bars).trades;
    expect(trades.every((t) => !t.open && t.signalTime < row.signalDate!)).toBe(true);
  });

  it("computes stats consistently with the trade list", () => {
    const res = divergenceStrategy(avav.bars);
    const { stats } = res;
    const closed = res.trades.filter((t) => !t.open);
    const wins = closed.filter((t) => t.pnl > 0);
    const losses = closed.filter((t) => t.pnl < 0);
    const net = closed.reduce((a, t) => a + t.pnl, 0);
    expect(stats.initialCapital).toBe(DIV_STRATEGY_DEFAULTS.initialCapital);
    expect(stats.closedTrades).toBe(closed.length);
    expect(stats.winningTrades).toBe(wins.length);
    expect(stats.losingTrades).toBe(losses.length);
    expect(stats.netProfit).toBeCloseTo(net, 9);
    expect(stats.netProfitPct).toBeCloseTo((net / 10000) * 100, 9);
    expect(stats.equity[0]).toEqual({ time: avav.bars[0]!.time, value: 10000 });
    expect(stats.equity.at(-1)!.value).toBeCloseTo(10000 + net, 9);
    expect(stats.grossProfit - stats.grossLoss).toBeCloseTo(net, 9);
    expect(stats.profitFactor).toBeCloseTo(stats.grossProfit / stats.grossLoss, 12);
    expect(stats.winRate).toBe(wins.length / closed.length);
    expect(stats.avgBars).toBe(HOLD_BARS);
    expect(stats.maxDrawdown).toBeGreaterThan(0);
    expect(stats.maxDrawdownPct).toBeGreaterThan(0);
    const first = avav.bars[0]!.close;
    const lastClose = avav.bars.at(-1)!.close;
    expect(stats.buyHoldPct).toBeCloseTo((lastClose / first - 1) * 100, 9);
    for (const t of res.trades) {
      expect(t.runUpPct).toBeGreaterThanOrEqual(0);
      expect(t.drawdownPct).toBeLessThanOrEqual(0);
      // 0.1% commission per fill
      if (!t.open) {
        const gross = ((t.exitPrice! - t.entryPrice) / t.entryPrice) * 100;
        expect(t.pnlPct).toBeCloseTo(gross - 0.1 - (0.1 * t.exitPrice!) / t.entryPrice, 9);
      }
    }
  });

  it("sizes from options and compounds closed P/L", () => {
    const base = divergenceStrategy(avav.bars);
    const big = divergenceStrategy(avav.bars, { initialCapital: 1_000_000, commissionPct: 0 });
    expect(big.trades[0]!.qty).toBe(Math.floor((1_000_000 * 10) / 100 / avav.bars[avav.trades[0]![0]]!.close));
    const t0 = big.trades[0]!;
    expect(t0.pnl).toBe(t0.qty * (t0.exitPrice! - t0.entryPrice));
    // second trade is sized from equity after the first
    const eq1 = 10000 + base.trades[0]!.pnl;
    expect(base.trades[1]!.qty).toBe(Math.floor((eq1 * 10) / 100 / avav.bars[avav.trades[1]![0]]!.close));
  });

  it("drops the qty from labels when the account can't buy a share", () => {
    const res = divergenceStrategy(avav.bars, { initialCapital: 1 });
    expect(res.trades.every((t) => t.qty === 0 && t.pnl === 0)).toBe(true);
    expect(new Set(res.markers.map((m) => m.label))).toEqual(new Set(["Long", "Time"]));
  });

  it("handles empty input", () => {
    const res = divergenceStrategy([]);
    expect(res.trades).toEqual([]);
    expect(res.markers).toEqual([]);
    expect(res.stats.closedTrades).toBe(0);
    expect(res.stats.profitFactor).toBe(0);
    expect(res.stats.equity).toEqual([]);
  });
});

describe("listDivergences", () => {
  const bars = fixture("AVGO").daily!.bars;

  it("filters by kind and collapses like the TradingView indicator", () => {
    const all = listDivergences(bars);
    const bulls = listDivergences(bars, 5, 10, 100, { kinds: ["bull"] });
    expect(bulls.every((d) => d.kind === "bull")).toBe(true);
    expect(bulls.length).toBe(all.filter((d) => d.kind === "bull").length);

    const collapsed = listDivergences(bars, 5, 10, 100, { collapse: true });
    expect(collapsed.length).toBeGreaterThan(0);
    expect(collapsed.length).toBeLessThan(all.length);
    for (const d of collapsed) expect(all).toContainEqual(d);
  });
});

describe("stoch markers and errors", () => {
  it("marks ARMED / CONFIRMED events with the pine debug labels", () => {
    const fx = fixture("EW").weekly!;
    const closed = dropForming(fx.bars, "1w", fx.nowMs);
    const expected = detectStochEvents(fx.k, fx.d)
      .filter((e) => e.stage !== "FAILED")
      .map((e) => ({
        time: closed[e.i]!.time,
        kind: "entry",
        label: e.stage === "ARMED" ? STOCH_ARMED_LABEL : STOCH_CONFIRMED_LABEL,
      }));
    expect(expected.length).toBeGreaterThan(0);
    expect(stochStrategyMarkers(closed)).toEqual(expected);
    // with nowMs the forming week is dropped first, like the scan
    expect(fx.bars.length).toBe(closed.length + 1);
    expect(stochStrategyMarkers(fx.bars, fx.nowMs)).toEqual(expected);
  });

  it("throws where the Python would", () => {
    const fx = fixture("AVGO").daily!;
    expect(() => scanDivergence("X", fx.bars.slice(0, 3))).toThrow();
    expect(() => scanDivergence("X", [])).toThrow();
    // a lone forming week leaves nothing to scan
    const forming = [bar(utc(2026, 11, 2, 5))];
    expect(() => scanStoch("X", forming, utc(2026, 11, 3))).toThrow();
  });
});

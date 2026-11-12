/**
 * Golden parity: TypeScript == trading-script's Python on real cached Alpaca
 * SIP bars. Fixtures come from ../__fixtures__/make_fixtures.py; floats are
 * compared bit for bit (the fixtures hold pandas' x86 results, see there).
 */
import { describe, expect, it } from "vitest";
import {
  analyzeDivergences,
  atr,
  barColumns,
  cci,
  cmf,
  detectStochEvents,
  divergenceStrategy,
  divSignals,
  dropForming,
  lastTrade,
  macdAll,
  mfi,
  momentum,
  obv,
  regularDivergence,
  rsi,
  scanDivergence,
  scanStoch,
  stochK,
  stochRsi,
  vwmacd,
} from "../index.ts";
import { firstMismatch, fixtures, sameNumber } from "./fixtures.ts";

function expectSameSeries(actual: readonly number[], expected: readonly number[], what: string) {
  const i = firstMismatch(actual, expected);
  expect(i, `${what}: first mismatch at ${i} (ts ${actual[i]} vs py ${expected[i]})`).toBe(-1);
}

/** Row equality with NaN-safe, bit-exact numbers. */
function expectSameRow(actual: object, expected: object, what: string) {
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  expect(Object.keys(a).sort(), what).toEqual(Object.keys(e).sort());
  for (const key of Object.keys(e)) {
    const av = a[key];
    const ev = e[key];
    if (typeof ev === "number" && typeof av === "number") {
      expect(sameNumber(av, ev), `${what}.${key}: ts ${av} vs py ${ev}`).toBe(true);
    } else {
      expect(av, `${what}.${key}`).toEqual(ev);
    }
  }
}

const daily = fixtures.filter((f) => f.daily);
const weekly = fixtures.filter((f) => f.weekly);

describe("fixtures", () => {
  it("cover every scan state", () => {
    expect(new Set(daily.map((f) => f.daily!.scan.state))).toEqual(new Set(["NEW", "HOLD", "EXIT", null]));
    expect(new Set(weekly.map((f) => f.weekly!.scan.stage))).toEqual(new Set(["ARMED", "CONFIRMED", "FAILED", null]));
    expect(weekly.some((f) => f.weekly!.dropped === 1)).toBe(true);
    expect(weekly.some((f) => f.weekly!.dropped === 0)).toBe(true);
  });

  it("native (arm64 FMA) pandas stays within 1e-6 of the bit-exact expectations", () => {
    for (const f of fixtures) expect(f.meta.nativeMaxRelDiff, f.case).toBeLessThan(1e-6);
  });
});

describe.each(daily.map((f) => [f.case, f] as const))("daily %s", (_name, f) => {
  const fx = f.daily!;
  const bars = fx.bars;

  it("indicators match pandas bit for bit", () => {
    const { high, low, close, volume } = barColumns(bars);
    const { macd, signal, hist } = macdAll(close);
    const srsi = stochRsi(close, 14, 14, 5, 5);
    const ours: Record<string, number[]> = {
      macd,
      signal,
      hist,
      rsi: rsi(close),
      stoch: stochK(high, low, close),
      cci: cci(close),
      mom: momentum(close),
      obv: obv(close, volume),
      vwmacd: vwmacd(close, volume),
      cmf: cmf(high, low, close, volume),
      mfi: mfi(close, volume),
      atr: atr(high, low, close, 14),
      stochRsiK: srsi.k,
      stochRsiD: srsi.d,
    };
    for (const seg of fx.indicators) {
      expect(Object.keys(seg.values).sort()).toEqual(Object.keys(ours).sort());
      for (const [name, expected] of Object.entries(seg.values)) {
        const actual = ours[name]!.slice(seg.start, seg.start + expected.length);
        expectSameSeries(actual, expected, `${name}@${seg.start}`);
      }
    }
  });

  it("regular_divergence counts match exactly", () => {
    const { divPos, divNeg } = regularDivergence(bars);
    expect(divPos).toEqual(fx.divPos);
    expect(divNeg).toEqual(fx.divNeg);
  });

  it("the divergence list adds up to the counts", () => {
    const a = analyzeDivergences(bars);
    const pos = new Array<number>(bars.length).fill(0);
    const neg = new Array<number>(bars.length).fill(0);
    const index = new Map(bars.map((b, i) => [b.time, i]));
    for (const d of a.divergences) {
      const i = index.get(d.time)!;
      (d.kind === "bull" ? pos : neg)[i]! += d.indicators.length;
      expect(d.fromTime).toBeLessThan(d.toTime);
      expect(d.toTime).toBe(bars[i - 1]!.time);
      expect(d.toPrice).toBe(bars[i - 1]!.close);
    }
    expect(pos).toEqual(fx.divPos);
    expect(neg).toEqual(fx.divNeg);
  });

  it("div_scan.scan row matches", () => {
    expectSameRow(scanDivergence(f.symbol, bars), fx.scan, "scan");
  });

  it("trade replay matches the Python replay and last_trade", () => {
    const sig = divSignals(bars);
    const last = bars.length - 1;
    const pyLast = fx.trades[fx.trades.length - 1];
    expect(lastTrade(sig.hit)).toEqual(pyLast ? pyLast.slice(0, 3) : null);

    const res = divergenceStrategy(bars);
    const filled = fx.trades.filter(([, e]) => e <= last);
    expect(res.trades).toHaveLength(filled.length);
    res.trades.forEach((t, j) => {
      const [s, e, x, divSum] = filled[j]!;
      expect(t.id).toBe(j + 1);
      expect(t.signalTime).toBe(bars[s]!.time);
      expect(t.entryTime).toBe(bars[e]!.time);
      expect(t.entryPrice).toBe(bars[e]!.open);
      expect(t.open).toBe(x > last);
      expect(t.exitTime).toBe(x > last ? null : bars[x]!.time);
      expect(t.exitPrice).toBe(x > last ? null : bars[x]!.open);
      expect(t.divSum).toBe(divSum);
      // sizing cross-check (independent Python re-statement of the pine's sizing)
      const tv = fx.tv[j]!;
      expect(t.qty).toBe(tv.qty);
      expect(sameNumber(t.pnl, tv.pnl), `pnl #${t.id}`).toBe(true);
    });
    const closedEquity = fx.tv.filter((t) => t.equity !== null).map((t) => t.equity);
    expect(res.stats.equity.slice(1).map((p) => p.value)).toEqual(closedEquity);
  });
});

describe.each(weekly.map((f) => [f.case, f] as const))("weekly %s", (_name, f) => {
  const fx = f.weekly!;
  const closed = dropForming(fx.bars, "1w", fx.nowMs);

  it("drop_forming drops exactly the forming week", () => {
    expect(fx.bars.length - closed.length).toBe(fx.dropped);
  });

  it("stoch_rsi and atr match pandas bit for bit", () => {
    const { high, low, close } = barColumns(closed);
    const { k, d } = stochRsi(close, 14, 14, 5, 5);
    expectSameSeries(k, fx.k, "k");
    expectSameSeries(d, fx.d, "d");
    expectSameSeries(atr(high, low, close, 14), fx.atr, "atr");
  });

  it("detect() events match", () => {
    const events = detectStochEvents(fx.k, fx.d);
    expect(events.map(({ stage, i, crossBar, gaps }) => ({ stage, i, crossBar, gaps }))).toEqual(
      fx.events.map(({ stage, i, crossBar, gaps }) => ({ stage, i, crossBar, gaps })),
    );
    events.forEach((ev, j) => expectSameSeries(ev.c, fx.events[j]!.c, `event ${j} c`));
  });

  it("stoch_scan.scan row matches", () => {
    expectSameRow(scanStoch(f.symbol, fx.bars, fx.nowMs), fx.scan, "scan");
  });
});

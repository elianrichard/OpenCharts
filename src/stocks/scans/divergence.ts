/**
 * Regular divergence across ten oscillators — port of
 * trading-script/backtest/indicators.py `regular_divergence` / `_div_one`
 * (itself a port of LonesomeTheBlue's "Divergence for Many Indicators v4",
 * regular divergences only, Close as the pivot source).
 *
 * One pass produces both the per-bar counts (`div_pos` / `div_neg`, what the
 * scan and the strategy use) and the individual divergences behind them (what
 * a chart draws), so the two can never disagree.
 */
import type { Bar, Divergence } from "../types.ts";
import { barColumns, cci, cmf, macdAll, mfi, momentum, obv, rsi, stochK, vwmacd } from "./indicators.ts";

/** Indicator keys, in the order the Python engine evaluates them. */
export const DIV_INDICATORS = ["macd", "hist", "rsi", "stoch", "cci", "mom", "obv", "vwmacd", "cmf", "mfi"] as const;
export type DivIndicator = (typeof DIV_INDICATORS)[number];

/** Label text the pine strategy prints for each indicator (divergence-buy.pine `divNames`). */
export const DIV_INDICATOR_LABELS: Readonly<Record<DivIndicator, string>> = {
  macd: "MACD",
  hist: "Hist",
  rsi: "RSI",
  stoch: "Stoch",
  cci: "CCI",
  mom: "MOM",
  obv: "OBV",
  vwmacd: "VWMACD",
  cmf: "CMF",
  mfi: "MFI",
};

/** Size of the pivot ring buffers (`maxarr` / pine `maxarraysize`). */
const MAX_PIVOTS = 20;
/** "Wait for confirmation": the divergence ends on the last closed candle. */
const SP = 1;

/** The ten oscillator series the engine compares against price. */
export function divergenceSeries(bars: readonly Bar[]): Record<DivIndicator, number[]> {
  const { high, low, close, volume } = barColumns(bars);
  const { macd, hist } = macdAll(close);
  return {
    macd,
    hist,
    rsi: rsi(close),
    stoch: stochK(high, low, close),
    cci: cci(close),
    mom: momentum(close),
    obv: obv(close, volume),
    vwmacd: vwmacd(close, volume),
    cmf: cmf(high, low, close, volume),
    mfi: mfi(close, volume),
  };
}

/**
 * Python `_div_one` for one indicator at bar i. Returns the matched line
 * length (bars back to the price pivot) for the positive and the negative
 * regular divergence, 0 when there is none.
 */
function divOne(
  src: readonly number[],
  close: readonly number[],
  plPos: readonly number[],
  plVal: readonly number[],
  phPos: readonly number[],
  phVal: readonly number[],
  i: number,
  prd: number,
  maxpp: number,
  maxbars: number,
): [number, number] {
  let pos = 0;
  let neg = 0;
  if (i - SP < 0) return [pos, neg];

  // positive regular (bullish): indicator higher low, price lower low
  if (src[i]! > src[i - 1]! || close[i]! > close[i - 1]!) {
    for (let x = 0; x < maxpp; x++) {
      const posX = plPos[x] ?? 0;
      if (posX === 0) break;
      const length = i - posX + prd;
      if (length > maxbars) break;
      if (length > 5 && i - length >= 0) {
        if (src[i - SP]! > src[i - length]! && close[i - SP]! < plVal[x]!) {
          const slope1 = (src[i - SP]! - src[i - length]!) / (length - SP);
          const slope2 = (close[i - SP]! - close[i - length]!) / (length - SP);
          let vl1 = src[i - SP]! - slope1;
          let vl2 = close[i - SP]! - slope2;
          let ok = true;
          for (let y = 1 + SP; y < length; y++) {
            if (src[i - y]! < vl1 || close[i - y]! < vl2) {
              ok = false;
              break;
            }
            vl1 -= slope1;
            vl2 -= slope2;
          }
          if (ok) {
            pos = length;
            break;
          }
        }
      }
    }
  }

  // negative regular (bearish): indicator lower high, price higher high
  if (src[i]! < src[i - 1]! || close[i]! < close[i - 1]!) {
    for (let x = 0; x < maxpp; x++) {
      const posX = phPos[x] ?? 0;
      if (posX === 0) break;
      const length = i - posX + prd;
      if (length > maxbars) break;
      if (length > 5 && i - length >= 0) {
        if (src[i - SP]! < src[i - length]! && close[i - SP]! > phVal[x]!) {
          const slope1 = (src[i - SP]! - src[i - length]!) / (length - SP);
          const slope2 = (close[i - SP]! - close[i - length]!) / (length - SP);
          let vl1 = src[i - SP]! - slope1;
          let vl2 = close[i - SP]! - slope2;
          let ok = true;
          for (let y = 1 + SP; y < length; y++) {
            if (src[i - y]! > vl1 || close[i - y]! > vl2) {
              ok = false;
              break;
            }
            vl1 -= slope1;
            vl2 -= slope2;
          }
          if (ok) {
            neg = length;
            break;
          }
        }
      }
    }
  }
  return [pos, neg];
}

export interface DivergenceAnalysis {
  /** Indicators with a positive (bullish) regular divergence, per bar. */
  divPos: number[];
  /** Indicators with a negative (bearish) regular divergence, per bar. */
  divNeg: number[];
  /**
   * Every detection behind those counts: one entry per bar, kind and distinct
   * price pivot, listing the indicators that agree on it. Summing
   * `indicators.length` per bar and kind gives divPos / divNeg exactly.
   */
  divergences: Divergence[];
  /** A pivot low / high on close was confirmed at this bar (prd bars after it). */
  pivotLow: boolean[];
  pivotHigh: boolean[];
}

/** Run the engine once: counts, divergence list and pivot confirmations. */
export function analyzeDivergences(bars: readonly Bar[], prd = 5, maxpp = 10, maxbars = 100): DivergenceAnalysis {
  const { time, close } = barColumns(bars);
  const n = bars.length;
  const all = divergenceSeries(bars);
  const series = DIV_INDICATORS.map((k) => all[k]);

  const plPos = new Array<number>(MAX_PIVOTS).fill(0);
  const plVal = new Array<number>(MAX_PIVOTS).fill(0);
  const phPos = new Array<number>(MAX_PIVOTS).fill(0);
  const phVal = new Array<number>(MAX_PIVOTS).fill(0);

  const divPos = new Array<number>(n).fill(0);
  const divNeg = new Array<number>(n).fill(0);
  const pivotLow = new Array<boolean>(n).fill(false);
  const pivotHigh = new Array<boolean>(n).fill(false);
  const divergences: Divergence[] = [];

  const posLens = new Array<number>(DIV_INDICATORS.length);
  const negLens = new Array<number>(DIV_INDICATORS.length);

  for (let i = 0; i < n; i++) {
    // detect a confirmed pivot (on close) prd bars back, strict on both sides
    if (i >= 2 * prd) {
      const mid = i - prd;
      const cv = close[mid]!;
      let isPh = true;
      let isPl = true;
      for (let k = -prd; k <= prd; k++) {
        if (k === 0) continue;
        const o = close[mid + k]!;
        if (!(cv > o)) isPh = false;
        if (!(cv < o)) isPl = false;
      }
      if (isPh) {
        phPos.unshift(i);
        phPos.pop();
        phVal.unshift(cv);
        phVal.pop();
        pivotHigh[i] = true;
      }
      if (isPl) {
        plPos.unshift(i);
        plPos.pop();
        plVal.unshift(cv);
        plVal.pop();
        pivotLow[i] = true;
      }
    }

    let p = 0;
    let q = 0;
    for (let k = 0; k < series.length; k++) {
      const s = series[k]!;
      posLens[k] = 0;
      negLens[k] = 0;
      if (s[i] !== s[i]) continue; // np.isnan
      const [dp, dn] = divOne(s, close, plPos, plVal, phPos, phVal, i, prd, maxpp, maxbars);
      posLens[k] = dp;
      negLens[k] = dn;
      if (dp > 0) p += 1;
      if (dn > 0) q += 1;
    }
    divPos[i] = p;
    divNeg[i] = q;
    if (p > 0) pushGroups(divergences, "bull", posLens, i, time, close);
    if (q > 0) pushGroups(divergences, "bear", negLens, i, time, close);
  }
  return { divPos, divNeg, divergences, pivotLow, pivotHigh };
}

/** One Divergence per distinct line length at bar i, indicators in engine order. */
function pushGroups(
  out: Divergence[],
  kind: Divergence["kind"],
  lens: readonly number[],
  i: number,
  time: readonly number[],
  close: readonly number[],
): void {
  const byLen = new Map<number, string[]>();
  lens.forEach((len, k) => {
    if (len <= 0) return;
    const names = byLen.get(len);
    if (names) names.push(DIV_INDICATORS[k]!);
    else byLen.set(len, [DIV_INDICATORS[k]!]);
  });
  for (const [len, indicators] of byLen) {
    out.push({
      kind,
      time: time[i]!,
      fromTime: time[i - len]!,
      fromPrice: close[i - len]!,
      toTime: time[i - SP]!,
      toPrice: close[i - SP]!,
      indicators,
    });
  }
}

/** Python `regular_divergence(df)`: per-bar counts of positive / negative regular divergences. */
export function regularDivergence(
  bars: readonly Bar[],
  prd = 5,
  maxpp = 10,
  maxbars = 100,
): { divPos: number[]; divNeg: number[] } {
  const { divPos, divNeg } = analyzeDivergences(bars, prd, maxpp, maxbars);
  return { divPos, divNeg };
}

export interface ListDivergenceOptions {
  /** Kinds to return; default both. */
  kinds?: readonly Divergence["kind"][];
  /**
   * Apply the TradingView indicator's redraw rule: a newer divergence of the
   * same kind before the next pivot (low for bull, high for bear) replaces the
   * previous bar's lines and label. Default false = every detection, which is
   * what the counts are built from.
   */
  collapse?: boolean;
}

/**
 * Each regular divergence the engine detected, with its price-pivot
 * endpoints: the line runs from the pivot (`fromTime`) to the last closed
 * candle before the detection bar (`toTime`), as in the pine indicator.
 */
export function listDivergences(
  bars: readonly Bar[],
  prd = 5,
  maxpp = 10,
  maxbars = 100,
  opts: ListDivergenceOptions = {},
): Divergence[] {
  const a = analyzeDivergences(bars, prd, maxpp, maxbars);
  const kinds = opts.kinds ?? ["bull", "bear"];
  let list = a.divergences.filter((d) => kinds.includes(d.kind));
  if (opts.collapse) list = collapseDivergences(list, bars, a.pivotLow, a.pivotHigh);
  return list;
}

function collapseDivergences(
  list: readonly Divergence[],
  bars: readonly Bar[],
  pivotLow: readonly boolean[],
  pivotHigh: readonly boolean[],
): Divergence[] {
  const indexOf = new Map<number, number>();
  bars.forEach((b, i) => indexOf.set(b.time, i));
  const keep = new Array<boolean>(list.length).fill(true);
  for (const kind of ["bull", "bear"] as const) {
    const pivots = kind === "bull" ? pivotLow : pivotHigh;
    let lastGroup: number[] = [];
    let lastBar = -1;
    let removable = false;
    list.forEach((d, idx) => {
      if (d.kind !== kind) return;
      const i = indexOf.get(d.time)!;
      if (i !== lastBar) {
        // a pivot confirmed since the last drawing locks that drawing in
        for (let j = lastBar + 1; j <= i; j++) if (pivots[j]) removable = false;
        if (removable) for (const g of lastGroup) keep[g] = false;
        lastGroup = [];
        lastBar = i;
        removable = true;
      }
      lastGroup.push(idx);
    });
  }
  return list.filter((_, idx) => keep[idx]);
}

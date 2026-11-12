/**
 * Loader for the golden fixtures written by ../__fixtures__/make_fixtures.py
 * (Python outputs of trading-script on cached Alpaca SIP bars).
 */
import type { Bar, DivScanRow, StochScanRow, StochStage } from "../../types.ts";

type Num = number | null | "inf" | "-inf";

interface BarsJson {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

interface FixtureJson {
  case: string;
  symbol: string;
  meta: { nativeMaxRelDiff: number; nativeEwm?: string; expected: string };
  daily?: {
    bars: BarsJson;
    divPos: number[];
    divNeg: number[];
    scan: DivScanRow;
    /** [signal, entry, exit, divSum] bar indices of every trade in the replay. */
    trades: [number, number, number, number][];
    tv: { qty: number; pnl: number; equity: number | null }[];
    indicators: { start: number; values: Record<string, Num[]> }[];
  };
  weekly?: {
    bars: BarsJson;
    nowMs: number;
    dropped: number;
    k: Num[];
    d: Num[];
    atr: Num[];
    events: { stage: StochStage; i: number; crossBar: number; gaps: number[]; c: number[] }[];
    scan: StochScanRow;
  };
}

export interface Fixture extends Omit<FixtureJson, "daily" | "weekly"> {
  daily?: Omit<NonNullable<FixtureJson["daily"]>, "bars" | "indicators"> & {
    bars: Bar[];
    indicators: { start: number; values: Record<string, number[]> }[];
  };
  weekly?: Omit<NonNullable<FixtureJson["weekly"]>, "bars" | "k" | "d" | "atr"> & {
    bars: Bar[];
    k: number[];
    d: number[];
    atr: number[];
  };
}

export function num(v: Num): number {
  if (v === null) return NaN;
  if (v === "inf") return Infinity;
  if (v === "-inf") return -Infinity;
  return v;
}

const nums = (a: Num[]) => a.map(num);

function toBars(b: BarsJson): Bar[] {
  return b.t.map((time, i) => ({ time, open: b.o[i]!, high: b.h[i]!, low: b.l[i]!, close: b.c[i]!, volume: b.v[i]! }));
}

const raw = import.meta.glob("../__fixtures__/*.json", { eager: true, query: "?raw", import: "default" }) as Record<
  string,
  string
>;

export const fixtures: Fixture[] = Object.keys(raw)
  .sort()
  .map((path) => {
    const f = JSON.parse(raw[path]!) as FixtureJson;
    return {
      ...f,
      daily: f.daily && {
        ...f.daily,
        bars: toBars(f.daily.bars),
        indicators: f.daily.indicators.map((seg) => ({
          start: seg.start,
          values: Object.fromEntries(Object.entries(seg.values).map(([k, v]) => [k, nums(v)])),
        })),
      },
      weekly: f.weekly && {
        ...f.weekly,
        bars: toBars(f.weekly.bars),
        k: nums(f.weekly.k),
        d: nums(f.weekly.d),
        atr: nums(f.weekly.atr),
      },
    };
  });

/** Same double, or both NaN (signed zeros compare equal). */
export function sameNumber(a: number, b: number): boolean {
  return a === b || (a !== a && b !== b);
}

/** Index of the first element that differs, or -1. */
export function firstMismatch(actual: readonly number[], expected: readonly number[]): number {
  if (actual.length !== expected.length) return Math.min(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) if (!sameNumber(actual[i]!, expected[i]!)) return i;
  return -1;
}

/** Largest |a - e| / max(|e|, 1e-12) over the non-NaN pairs. */
export function maxRelError(actual: readonly number[], expected: readonly number[]): number {
  let worst = 0;
  expected.forEach((e, i) => {
    const a = actual[i]!;
    if (e !== e || a !== a) return;
    worst = Math.max(worst, Math.abs(a - e) / Math.max(Math.abs(e), 1e-12));
  });
  return worst;
}

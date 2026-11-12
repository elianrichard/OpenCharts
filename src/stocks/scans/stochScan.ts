/**
 * Stoch RSI 4-cross — port of trading-script/railway/stoch_scan.py
 * (pine/strategies/stoch-strat-new.pine).
 *
 * Bottoming pattern on the Stoch RSI, last four K/D crosses:
 *   1st (bear) above LVL1 -> 2nd (bull) below LVL2 -> 3rd (bear) at/above the
 *   2nd (within TOL) and below LVL1 -> 4th (bull) below LVL4.
 * Cross values are the interpolated K/D intersections, and a cross only
 * enters the window once |K-D| reaches MIN_SEP. Stages: ARMED on the 4th
 * cross commit; CONFIRMED (or FAILED) CONFIRM_BARS after the 4th cross.
 */
import type { Bar, StochScanRow, StochStage, StrategyMarker } from "../types.ts";
import { atr, barColumns, stochRsi } from "./indicators.ts";

export { stochRsi };

// pine input defaults — keep in sync with stoch_scan.py / stoch-strat-new.pine
export const SMOOTH_K = 5;
export const SMOOTH_D = 5;
export const RSI_LEN = 14;
export const STOCH_LEN = 14;
/** 1st cross min / 2nd cross max / 4th cross max level. */
export const LVL1 = 75.0;
export const LVL2 = 70.0;
export const LVL4 = 50.0;
/** 3rd-vs-2nd tolerance. */
export const TOL = 10.0;
/** Bars between consecutive crosses. */
export const MIN_GAP = 1;
export const MAX_GAP = 15;
/** |K-D| needed to accept a cross. */
export const MIN_SEP = 2.0;
/** Bars after the 4th cross to confirm. */
export const CONFIRM_BARS = 1;
/** Min K-D spread at confirm. */
export const CONFIRM_KD_GAP = 1.0;
export const ATR_LEN = 14;
export const SL_MULT = 1.5;
export const TP_MULT = 3.0;

/** Weekly only (1d and 1mo showed no edge in the backtests). */
export const STOCH_INTERVALS = ["1w"] as const;
/** History each interval needs for the RMA-based RSI to settle. */
export const STOCH_STARTS: Readonly<Record<"1d" | "1w" | "1mo", string>> = {
  "1d": "2025-07-01",
  "1w": "2021-01-01",
  "1mo": "2016-01-01",
};
/** Signal freshness window ≈ two bars. */
export const STOCH_MAX_DAYS: Readonly<Record<"1d" | "1w" | "1mo", number>> = { "1d": 7, "1w": 14, "1mo": 60 };

export interface StochEvent {
  stage: StochStage;
  /** Bar index of the event (arm bar, or the confirm / fail bar). */
  i: number;
  /** Bar index of the 4th cross. */
  crossBar: number;
  /** Interpolated K/D values of the four crosses, oldest first. */
  c: [number, number, number, number];
  /** Bars between consecutive crosses. */
  gaps: [number, number, number];
}

type Slot = number | null;

/** stoch_scan.detect: run the pine state machine over K/D arrays. */
export function detectStochEvents(k: readonly number[], d: readonly number[]): StochEvent[] {
  let c: [Slot, Slot, Slot, Slot] = [null, null, null, null];
  let b: [Slot, Slot, Slot, Slot] = [null, null, null, null];
  let pendC: number | null = null;
  let pendB: number | null = null;
  let pendDir: 1 | -1 | null = null;
  let lastDir: 1 | -1 | null = null;
  let pendingArm: StochEvent | null = null;
  const events: StochEvent[] = [];

  for (let i = 1; i < k.length; i++) {
    const ki = k[i]!;
    const di = d[i]!;
    const kp = k[i - 1]!;
    const dp = d[i - 1]!;
    if (ki !== ki || di !== di || kp !== kp || dp !== dp) continue;
    const co = ki > di && kp <= dp;
    const cu = ki < di && kp >= dp;

    // stage the cross; an opposite cross before MIN_SEP separation
    // overwrites it, so touch-and-separate noise pairs never commit
    if (co || cu) {
      const dk = ki - kp;
      const dd = di - dp;
      const denom = dk - dd;
      const cval = Math.abs(denom) < 1e-10 ? (ki + di) / 2 : kp + ((dp - kp) / denom) * dk;
      pendC = cval;
      pendB = i;
      pendDir = co ? 1 : -1;
    }

    let bullCommit = false;
    if (pendC !== null && Math.abs(ki - di) >= MIN_SEP) {
      if (lastDir !== null && pendDir === lastDir) {
        // noise pair dropped in between: merge into slot 4
        c[3] = pendDir === 1 ? Math.min(c[3]!, pendC) : Math.max(c[3]!, pendC);
        b[3] = pendB;
      } else {
        c = [c[1], c[2], c[3], pendC];
        b = [b[1], b[2], b[3], pendB];
      }
      bullCommit = pendDir === 1;
      lastDir = pendDir;
      pendC = pendB = pendDir = null;
    }

    // arm on a bull commit that completes the level+gap shape
    if (bullCommit && c[0] !== null && pendingArm === null) {
      const [c1, c2, c3, c4] = c as [number, number, number, number];
      const [b1, b2, b3, b4] = b as [number, number, number, number];
      const condLvl = c1 > LVL1 && c2 < LVL2 && (c3 > c2 || Math.abs(c3 - c2) <= TOL) && c3 < LVL1 && c4 < LVL4;
      const gaps: [number, number, number] = [b2 - b1, b3 - b2, b4 - b3];
      const condGap = gaps.every((g) => MIN_GAP <= g && g <= MAX_GAP);
      if (condLvl && condGap) {
        pendingArm = { stage: "ARMED", i, crossBar: b4, c: [c1, c2, c3, c4], gaps };
        events.push(pendingArm);
      }
    }

    // resolve CONFIRM_BARS after the 4th cross (commit may lag it)
    if (pendingArm !== null && i - pendingArm.crossBar >= CONFIRM_BARS) {
      const ok = ki > di && ki - di > CONFIRM_KD_GAP && ki < LVL2;
      events.push({ ...pendingArm, stage: ok ? "CONFIRMED" : "FAILED", i });
      pendingArm = null;
    }
  }
  return events;
}

const DAY = 86400;

/** Python `date.weekday()` (Monday = 0) of a UTC day start. */
function weekday(daySec: number): number {
  return (new Date(daySec * 1000).getUTCDay() + 6) % 7;
}

/** Last business day (Mon-Fri) of the UTC month containing daySec, as a UTC day start. */
function lastBusinessDay(year: number, month: number): number {
  let day = Date.UTC(year, month + 1, 0) / 1000; // day 0 of next month = last day
  while (weekday(day) > 4) day -= DAY;
  return day;
}

/**
 * stoch_scan.drop_forming: drop a 1w/1mo bar that hasn't closed yet. A bar
 * counts as closed from 21:00 UTC on its last weekday (Friday for weeks, the
 * last business day for months). Bar times are read as UTC, like the Python.
 */
export function dropForming(bars: readonly Bar[], interval: string, nowMs: number): Bar[] {
  const lastBar = bars[bars.length - 1];
  if ((interval !== "1w" && interval !== "1mo") || !lastBar) return bars.slice();
  const start = Math.floor(lastBar.time / DAY) * DAY; // normalize()
  let lastDay: number;
  if (interval === "1w") {
    lastDay = start + (4 - weekday(start)) * DAY;
  } else {
    // start + BMonthEnd(0): roll forward to the month's last business day
    const dt = new Date(start * 1000);
    lastDay = lastBusinessDay(dt.getUTCFullYear(), dt.getUTCMonth());
    if (lastDay < start) lastDay = lastBusinessDay(dt.getUTCFullYear(), dt.getUTCMonth() + 1);
  }
  const closesMs = (lastDay + 21 * 3600) * 1000;
  return nowMs < closesMs ? bars.slice(0, -1) : bars.slice();
}

/** Stoch RSI K/D with the scan's settings (5, 5, 14, 14). */
export function scanStochRsi(close: readonly number[]): { k: number[]; d: number[] } {
  return stochRsi(close, RSI_LEN, STOCH_LEN, SMOOTH_K, SMOOTH_D);
}

/**
 * stoch_scan.scan(symbol, "1w"). Drops the forming week first (as of nowMs,
 * epoch ms); the row reflects the last event: an ARMED still awaiting
 * confirmation, a CONFIRMED entry, or a FAILED confirm. Throws when no closed
 * bar is left.
 */
export function scanStoch(symbol: string, weeklyBars: readonly Bar[], nowMs: number): StochScanRow {
  const bars = dropForming(weeklyBars, "1w", nowMs);
  const lastBar = bars[bars.length - 1];
  if (!lastBar) throw new Error(`${symbol}: no closed weekly bars`);
  const cols = barColumns(bars);
  const { k, d } = scanStochRsi(cols.close);
  const events = detectStochEvents(k, d);

  const row: StochScanRow = {
    symbol,
    interval: "1w",
    lastBar: lastBar.time,
    price: lastBar.close,
    stage: null,
    signalDate: null,
    daysSince: null,
    entry: null,
    sl: null,
    tp: null,
    fresh: false,
    crosses: null,
    gaps: null,
    nEvents: events.length,
  };
  const ev = events[events.length - 1];
  if (!ev) return row;

  const ts = bars[ev.i]!.time;
  const entry = bars[ev.i]!.close;
  const a = atr(cols.high, cols.low, cols.close, ATR_LEN)[ev.i]!;
  const sl = entry - SL_MULT * a;
  const daysSince = Math.floor((lastBar.time - ts) / DAY); // Timedelta.days
  row.stage = ev.stage;
  row.signalDate = ts;
  row.daysSince = daysSince;
  row.entry = entry;
  row.sl = sl;
  row.tp = entry + TP_MULT * a;
  row.fresh = daysSince <= STOCH_MAX_DAYS["1w"];
  row.crosses = [...ev.c];
  row.gaps = [...ev.gaps];
  return row;
}

/** stoch-strat-new.pine debug labels: "P" = PATTERN (armed), "4X" = ENTRY (confirmed). */
export const STOCH_ARMED_LABEL = "P";
export const STOCH_CONFIRMED_LABEL = "4X";

/**
 * ARMED / CONFIRMED markers for a chart, labelled like the pine's debug
 * plotshapes. FAILED confirms are not marked. With nowMs (epoch ms) the
 * forming bar is dropped first, as the scan does; without it every bar is
 * used, so a forming bar can show provisional events.
 */
export function stochStrategyMarkers(bars: readonly Bar[], nowMs?: number, interval = "1w"): StrategyMarker[] {
  const used = nowMs === undefined ? bars : dropForming(bars, interval, nowMs);
  const { k, d } = scanStochRsi(used.map((b) => b.close));
  const out: StrategyMarker[] = [];
  for (const ev of detectStochEvents(k, d)) {
    if (ev.stage === "FAILED") continue;
    out.push({
      time: used[ev.i]!.time,
      kind: "entry",
      label: ev.stage === "ARMED" ? STOCH_ARMED_LABEL : STOCH_CONFIRMED_LABEL,
    });
  }
  return out;
}

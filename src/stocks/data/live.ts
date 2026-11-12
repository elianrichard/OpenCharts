import type { Bar, StockSnapshot } from "../types.ts";
import {
  alpacaBarOpenMs,
  chartSafeTickTime,
  etDateKey,
  isIntraday,
  marketSession,
  type StockTimeframe,
} from "./time.ts";

/**
 * Pure pieces of the adapter's live path: which trade a chart should close on,
 * how the forming bar is built from the last polled bar plus that trade, and
 * the tick a snapshot turns into.
 */

export interface TradePoint {
  price: number;
  ms: number;
}

/** The newest trade of any session: what the watchlist and tick stream show. */
export function latestTrade(snap: StockSnapshot | undefined): TradePoint | null {
  if (!snap) return null;
  if (snap.extended && snap.extended.time != null) return { price: snap.extended.price, ms: snap.extended.time };
  if (snap.last != null && snap.lastTime != null) return { price: snap.last, ms: snap.lastTime };
  return null;
}

/**
 * The trade a bar of `tf` closes on. Intraday bars include extended hours (as
 * Alpaca's do); daily and weekly bars are regular-session only, so they use
 * the regular price.
 */
export function chartTrade(tf: StockTimeframe, snap: StockSnapshot | undefined): TradePoint | null {
  if (!snap) return null;
  if (isIntraday(tf)) return latestTrade(snap);
  return snap.last != null && snap.lastTime != null ? { price: snap.last, ms: snap.lastTime } : null;
}

/**
 * The forming bar for a chart: `base` (the newest bar from /bars, SIP plus the
 * IEX tail) with the latest trade folded in.
 *
 * Only a trade from today (New York) is folded in. Snapshots are unadjusted
 * while bars are `adjustment=all`, so merging an older session's quote into
 * its bar would nudge it off history on dividend days.
 */
export function buildLiveBar(
  tf: StockTimeframe,
  base: Bar | null,
  snap: StockSnapshot | undefined,
  nowMs: number,
): Bar | null {
  const trade = chartTrade(tf, snap);
  if (!trade || etDateKey(trade.ms) !== etDateKey(nowMs)) return base;
  const open = Math.floor(alpacaBarOpenMs(tf, trade.ms) / 1000);
  const p = trade.price;
  const session = !isIntraday(tf) && snap ? snap : null;

  if (base && base.time === open) {
    return {
      time: base.time,
      open: base.open,
      high: Math.max(base.high, p, session?.high ?? -Infinity),
      low: Math.min(base.low, p, session?.low ?? Infinity),
      close: p,
      volume: tf === "1d" ? Math.max(base.volume, session?.volume ?? 0) : base.volume,
    };
  }
  if (base && base.time > open) return base;

  // A bar Alpaca has not served yet (the free plan's SIP delay).
  if (session) {
    return {
      time: open,
      open: session.open ?? p,
      high: Math.max(session.high ?? p, p),
      low: Math.min(session.low ?? p, p),
      close: p,
      volume: session.volume ?? 0,
    };
  }
  return { time: open, open: p, high: p, low: p, close: p, volume: 0 };
}

export function sameBar(a: Bar | null | undefined, b: Bar | null | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.time === b.time &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume
  );
}

/**
 * Tick timestamp that is safe on every chart timeframe at once.
 *
 * ChartPanel folds ticks into the bar on UTC multiples of the timeframe, and
 * it re-applies the stored tick whenever its history changes, so a tick
 * emitted while a 1m chart was up is replayed onto the daily or weekly chart
 * the user switches to next. Alpaca's daily (00:00 ET) and weekly (Monday)
 * bars are off that grid; a raw trade time can land in a later UTC bucket and
 * open a phantom candle, after which the real bar can no longer be updated.
 *
 * So a regular-session time is held where neither daily nor weekly charts act
 * on it (chartSafeTickTime), and an extended-hours print is dated just before
 * the regular session's weekly bar, so it never touches a daily or weekly
 * candle (those are regular-session only), in candle or Heikin Ashi style.
 * Charts still move on every poll through the adapter's `candle` events. The
 * real trade time is in the snapshot (`lastTime`, `extended.time`).
 */
export function tickTimestamp(trade: TradePoint, snap: StockSnapshot | undefined): number {
  const regularMs = snap?.lastTime ?? trade.ms;
  const weekOpen = alpacaBarOpenMs("1w", regularMs);
  if (marketSession(trade.ms) !== "regular") return Math.min(trade.ms, weekOpen - 1);
  const t = chartSafeTickTime(trade.ms, "1d", alpacaBarOpenMs("1d", regularMs));
  return chartSafeTickTime(t, "1w", weekOpen);
}

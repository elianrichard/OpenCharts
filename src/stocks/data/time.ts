/**
 * US equity calendar helpers shared by the browser adapter and the dev-server
 * plugin. Pure: no I/O, no Node APIs.
 *
 * Holidays and early closes are not modelled. Callers that need "did the
 * market trade today" look at bar and trade timestamps instead of the clock.
 */

export const ET_TIMEZONE = "America/New_York";

/** Bar length per OpenCharts timeframe, and the bucket size ChartPanel uses. */
export const TIMEFRAME_MS = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 3_600_000,
  "4h": 4 * 3_600_000,
  "1d": 86_400_000,
  "1w": 7 * 86_400_000,
} as const;

export type StockTimeframe = keyof typeof TIMEFRAME_MS;

export function isStockTimeframe(tf: string): tf is StockTimeframe {
  return Object.prototype.hasOwnProperty.call(TIMEFRAME_MS, tf);
}

export function isIntraday(tf: StockTimeframe): boolean {
  return tf !== "1d" && tf !== "1w";
}

export type MarketSession = "pre" | "regular" | "post" | "closed";

/** Session boundaries in minutes after midnight ET. */
export const SESSION_MINUTES = {
  preOpen: 4 * 60,
  open: 9 * 60 + 30,
  close: 16 * 60,
  postClose: 20 * 60,
} as const;

export interface EtParts {
  /** YYYY-MM-DD in New York. */
  dateKey: string;
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday. */
  weekday: number;
  hour: number;
  minute: number;
  second: number;
  /** Minutes after local midnight. */
  minutes: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

let formatter: Intl.DateTimeFormat | null = null;

function etFormatter(): Intl.DateTimeFormat {
  formatter ??= new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  return formatter;
}

export function etParts(ms: number): EtParts {
  const parts: Record<string, string> = {};
  for (const p of etFormatter().formatToParts(new Date(ms))) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  // Some engines still print midnight as "24" even with h23.
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    year,
    month,
    day,
    weekday: WEEKDAYS[parts.weekday ?? ""] ?? new Date(ms).getUTCDay(),
    hour,
    minute,
    second,
    minutes: hour * 60 + minute,
  };
}

export function etDateKey(ms: number): string {
  return etParts(ms).dateKey;
}

/** New York wall clock minus UTC at `ms`, in ms (-5h in winter, -4h in summer). */
export function etOffsetMs(ms: number): number {
  const p = etParts(ms);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

function parseDateKey(dateKey: string): [number, number, number] {
  const [y, m, d] = dateKey.split("-").map(Number);
  return [y ?? 1970, m ?? 1, d ?? 1];
}

/** Epoch ms of 00:00 New York time on `dateKey`. */
export function etMidnightMs(dateKey: string): number {
  const [y, m, d] = parseDateKey(dateKey);
  // 05:00 UTC is 00:00 or 01:00 in New York: before the 02:00 DST switch, so
  // it carries the same offset as midnight itself.
  const offset = etOffsetMs(Date.UTC(y, m - 1, d, 5));
  return Date.UTC(y, m - 1, d) - offset;
}

export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = parseDateKey(dateKey);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Session by New York wall clock. Weekends are closed; holidays are not known. */
export function marketSession(ms: number): MarketSession {
  const p = etParts(ms);
  if (p.weekday === 0 || p.weekday === 6) return "closed";
  if (p.minutes < SESSION_MINUTES.preOpen) return "closed";
  if (p.minutes < SESSION_MINUTES.open) return "pre";
  if (p.minutes < SESSION_MINUTES.close) return "regular";
  if (p.minutes < SESSION_MINUTES.postClose) return "post";
  return "closed";
}

/**
 * Open time (epoch ms) of the Alpaca bar that contains `ms`.
 *
 * Alpaca anchors daily bars at 00:00 New York and weekly bars at Monday 00:00
 * New York. Intraday bars, 4Hour included, sit on UTC multiples of their
 * length (verified against the live API).
 */
export function alpacaBarOpenMs(tf: StockTimeframe, ms: number): number {
  if (tf === "1d") return etMidnightMs(etDateKey(ms));
  if (tf === "1w") {
    const p = etParts(ms);
    return etMidnightMs(addDays(p.dateKey, -((p.weekday + 6) % 7)));
  }
  const size = TIMEFRAME_MS[tf];
  return Math.floor(ms / size) * size;
}

/**
 * Timestamp to put on a tick so ChartPanel's tick smoothing cannot open a
 * phantom bar.
 *
 * ChartPanel buckets ticks on UTC multiples of the timeframe, which matches
 * Alpaca's intraday bars but not its daily (00:00 ET) or weekly (Monday) ones.
 * A tick whose UTC bucket is later than the charted bar's open would start a
 * stray candle (every Thursday on the weekly chart, for example). For those
 * timeframes the tick time is held inside the bucket at or before the bar's
 * open, where ChartPanel ignores it; the adapter's `candle` events move the
 * bar instead. Aligned timeframes keep the real trade time.
 */
export function chartSafeTickTime(tradeMs: number, tf: StockTimeframe, barOpenMs: number): number {
  const size = TIMEFRAME_MS[tf];
  if (barOpenMs % size === 0) return tradeMs;
  const limit = (Math.floor(barOpenMs / size) + 1) * size - 1;
  return Math.min(tradeMs, limit);
}

/**
 * Identifies which scan results are current. Changes at midnight New York and
 * again at 16:20 on weekdays, once the closing auction has settled in SIP.
 */
export function scanEpoch(ms: number): string {
  const p = etParts(ms);
  const weekday = p.weekday >= 1 && p.weekday <= 5;
  const settled = weekday && p.minutes >= SESSION_MINUTES.close + 20;
  return `${p.dateKey}${settled ? "+close" : ""}`;
}

import type { Bar, StockSnapshot } from "../types.ts";
import { SESSION_MINUTES, etDateKey, etMidnightMs, marketSession } from "../data/time.ts";
import type { RawBar, RawQuote, RawSnapshot, RawTrade } from "./alpaca.ts";

/**
 * Builds the watchlist/details snapshot from two Alpaca snapshot feeds:
 *
 *   iex          real time, IEX only: regular-hours trades and quotes. IEX
 *                prints nothing outside 09:30-16:00 and its quotes there are
 *                placeholders, so they are ignored.
 *   delayed_sip  every exchange, 15 minutes late: the session bar (official
 *                open/close, full-day volume), the previous close, and
 *                pre/post-market trades.
 *
 * Verified against the live API: SIP daily bars cover the regular session
 * (open/close are the official prints) and roll over at the open, so before
 * 09:30 the session bar is still the previous day's.
 *
 * Prices are split the way TradingView shows them: `last`/`change` describe
 * the regular session and a pre- or post-market trade goes in `extended`.
 * Snapshot prices are unadjusted (bars are `adjustment=all`), which is what a
 * quote should show.
 */

interface Trade {
  price: number;
  ms: number;
}

function toTrade(raw: RawTrade | null | undefined): Trade | null {
  if (!raw) return null;
  const ms = Date.parse(raw.t);
  return Number.isFinite(ms) && raw.p > 0 ? { price: raw.p, ms } : null;
}

function validBar(raw: RawBar | null | undefined): RawBar | null {
  return raw && Number.isFinite(Date.parse(raw.t)) && raw.c > 0 ? raw : null;
}

function barDate(raw: RawBar): string {
  return etDateKey(Date.parse(raw.t));
}

function positive(n: number | null | undefined): number | null {
  return n != null && Number.isFinite(n) && n > 0 ? n : null;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function changeOf(price: number | null, base: number | null): { change: number | null; changePct: number | null } {
  if (price == null || base == null || base <= 0) return { change: null, changePct: null };
  return { change: round(price - base, 4), changePct: round((price / base - 1) * 100, 4) };
}

/** Last instant of the regular session on New York day `dateKey`. */
export function sessionCloseMs(dateKey: string): number {
  return etMidnightMs(dateKey) + SESSION_MINUTES.close * 60_000 - 1_000;
}

/** Widest bid/ask spread, as a fraction of the mid, still treated as a real quote. */
export const MAX_SPREAD = 0.02;

/** The newest quote that looks like a market: both sides set, not crossed, not absurdly wide. */
export function pickQuote(quotes: (RawQuote | null | undefined)[]): { bid: number; ask: number } | null {
  let best: { bid: number; ask: number; ms: number } | null = null;
  for (const q of quotes) {
    if (!q) continue;
    const ms = Date.parse(q.t);
    if (!(q.bp > 0) || !(q.ap > 0) || q.ap < q.bp || !Number.isFinite(ms)) continue;
    const mid = (q.bp + q.ap) / 2;
    if ((q.ap - q.bp) / mid > MAX_SPREAD) continue;
    if (!best || ms > best.ms) best = { bid: q.bp, ask: q.ap, ms };
  }
  return best ? { bid: best.bid, ask: best.ask } : null;
}

export interface SnapshotInput {
  symbol: string;
  iex?: RawSnapshot | null;
  sip?: RawSnapshot | null;
  nowMs: number;
  avgVolume30: number | null;
}

export function buildSnapshot(input: SnapshotInput): StockSnapshot {
  const { symbol, iex, sip, nowMs } = input;
  const nowSession = marketSession(nowMs);

  const sipTrade = toTrade(sip?.latestTrade);
  const trades = [toTrade(iex?.latestTrade), sipTrade].filter((t): t is Trade => t !== null);
  const newest = (list: Trade[]) => list.reduce<Trade | null>((a, t) => (!a || t.ms > a.ms ? t : a), null);
  const latest = newest(trades);
  const latestRegular = newest(trades.filter((t) => marketSession(t.ms) === "regular"));

  // The session bar: SIP's, unless IEX already rolled to a newer day (the
  // first 15 minutes of a session, before delayed SIP catches up).
  const sipDaily = validBar(sip?.dailyBar);
  const iexDaily = validBar(iex?.dailyBar);
  let session: RawBar | null = sipDaily ?? iexDaily;
  let previous: RawBar | null = sipDaily ? validBar(sip?.prevDailyBar) : validBar(iex?.prevDailyBar);
  if (sipDaily && iexDaily && barDate(iexDaily) > barDate(sipDaily)) {
    session = iexDaily;
    previous = sipDaily;
  }
  const sessionDate = session ? barDate(session) : null;
  // Once delayed SIP has printed past the close, its session bar carries the official close.
  const sipHasClose = sipTrade != null && sessionDate != null && sipTrade.ms > sessionCloseMs(sessionDate);

  let last: number | null = null;
  let lastTime: number | null = null;
  let prevClose: number | null = null;
  let sessionBar: RawBar | null = session;

  const regularIsCurrent =
    latestRegular != null && (sessionDate == null || etDateKey(latestRegular.ms) >= sessionDate);
  if (latestRegular && regularIsCurrent && (nowSession === "regular" || !sipHasClose || !session)) {
    last = latestRegular.price;
    lastTime = latestRegular.ms;
    if (sessionDate && etDateKey(latestRegular.ms) > sessionDate) {
      // Today's bar is not in either snapshot yet: the session bar is yesterday.
      prevClose = positive(session?.c);
      sessionBar = null;
    } else {
      prevClose = positive(previous?.c);
    }
  } else if (session && sessionDate) {
    last = session.c;
    lastTime = sessionCloseMs(sessionDate);
    prevClose = positive(previous?.c);
  } else if (latest) {
    last = latest.price;
    lastTime = latest.ms;
  }
  const { change, changePct } = changeOf(last, prevClose);

  let extended: StockSnapshot["extended"] = null;
  if (
    nowSession !== "regular" &&
    latest &&
    last != null &&
    lastTime != null &&
    latest.ms > lastTime &&
    marketSession(latest.ms) !== "regular"
  ) {
    const kind = sessionDate && etDateKey(latest.ms) > sessionDate ? "pre" : "post";
    const delta = changeOf(latest.price, last);
    extended = {
      price: latest.price,
      change: delta.change ?? 0,
      changePct: delta.changePct ?? 0,
      session: kind,
      time: latest.ms,
    };
  }

  // Session range, stretched by a regular trade newer than delayed SIP has seen.
  let open = positive(sessionBar?.o);
  let high = positive(sessionBar?.h);
  let low = positive(sessionBar?.l);
  if (latestRegular && last === latestRegular.price && lastTime === latestRegular.ms) {
    open ??= last;
    high = Math.max(high ?? last, last);
    low = Math.min(low ?? last, last);
  }
  // Only SIP volume is consolidated; an IEX-only day total would mislead.
  const volume = sessionBar && sessionBar === sipDaily ? sessionBar.v : null;

  const quote = pickQuote([iex?.latestQuote, sip?.latestQuote]);
  return {
    symbol,
    last,
    lastTime,
    prevClose,
    change,
    changePct,
    open,
    high,
    low,
    volume,
    avgVolume30: input.avgVolume30,
    bid: quote?.bid ?? null,
    ask: quote?.ask ?? null,
    extended,
  };
}

/**
 * Mean volume of the last `n` completed sessions (bars dated before today in
 * New York). null when there are fewer than `n` of them.
 */
export function averageVolume(bars: Bar[] | null | undefined, nowMs: number, n = 30): number | null {
  if (!bars || bars.length === 0) return null;
  const today = etDateKey(nowMs);
  let end = bars.length;
  while (end > 0 && etDateKey(bars[end - 1]!.time * 1000) >= today) end--;
  if (end < n) return null;
  let sum = 0;
  for (let i = end - n; i < end; i++) sum += bars[i]!.volume;
  return Math.round(sum / n);
}

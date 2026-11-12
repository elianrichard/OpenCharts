import type { Bar } from "../types.ts";
import { TIMEFRAME_MS, isIntraday, type StockTimeframe } from "../data/time.ts";
import type { AlpacaCredentials } from "./config.ts";
import { createRateLimiter, type Priority, type RateLimiter } from "./rateLimit.ts";

/**
 * Server-side Alpaca market-data client. Holds the keys; nothing it returns or
 * throws contains them.
 *
 * Bars mirror trading-script/backtest/data.py: SIP feed (every exchange, what
 * TradingView shows) with `adjustment=all`. The free plan refuses SIP data from
 * the last 15 minutes, so SIP requests stop 16 minutes ago and intraday charts
 * fill that gap from the real-time IEX feed.
 */

// ── Pure helpers (exported for tests) ─────────────────────

export const ALPACA_TIMEFRAMES: Record<StockTimeframe, string> = {
  "1m": "1Min",
  "5m": "5Min",
  "15m": "15Min",
  "30m": "30Min",
  "1h": "1Hour",
  "4h": "4Hour",
  "1d": "1Day",
  "1w": "1Week",
};

export function toAlpacaTimeframe(tf: string): string | null {
  return (ALPACA_TIMEFRAMES as Record<string, string>)[tf] ?? null;
}

/** SIP data younger than 15 minutes is off-limits on the free plan; keep a minute of slack. */
export const SIP_DELAY_MS = 16 * 60_000;

/** Alpaca's page size ceiling. */
export const MAX_PAGE = 10_000;

/** Bars served when a request gives neither a start nor a limit. */
export const DEFAULT_LIMIT = 1_000;

/** SIP history on Alpaca starts in 2016; nothing earlier is worth asking for. */
const HISTORY_FLOOR_MS = Date.UTC(2015, 0, 1);

export interface RawBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface RawTrade {
  t: string;
  p: number;
}

export interface RawQuote {
  t: string;
  bp: number;
  ap: number;
}

export interface RawSnapshot {
  latestTrade?: RawTrade | null;
  latestQuote?: RawQuote | null;
  minuteBar?: RawBar | null;
  dailyBar?: RawBar | null;
  prevDailyBar?: RawBar | null;
}

export interface RawAsset {
  symbol: string;
  name: string;
  exchange: string;
  tradable: boolean;
  status?: string;
}

export function rawToBar(raw: RawBar): Bar {
  return {
    time: Math.floor(Date.parse(raw.t) / 1000),
    open: raw.o,
    high: raw.h,
    low: raw.l,
    close: raw.c,
    volume: raw.v,
  };
}

function isValidBar(bar: Bar): boolean {
  return (
    Number.isFinite(bar.time) &&
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close)
  );
}

/** RFC 3339 at whole seconds, the format Alpaca documents. */
export function toRfc3339(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Inclusive SIP end for a request whose exclusive end is `endMs` (or now):
 * one second before the bound, and never inside the free plan's 15 minutes.
 */
export function clipSipEnd(endMs: number | undefined, nowMs: number): number {
  const bound = (endMs ?? nowMs) - 1_000;
  return Math.min(bound, nowMs - SIP_DELAY_MS);
}

/**
 * How far back to open a newest-first query so it can find `limit` bars.
 * Generous on purpose: Alpaca stops at the limit, so a wide start costs
 * nothing, while a narrow one would come back short over weekends and holidays.
 */
export function lookbackStartMs(tf: StockTimeframe, endMs: number, limit: number): number {
  const size = TIMEFRAME_MS[tf];
  let span: number;
  if (tf === "1w") span = limit * size * 1.1 + 30 * 86_400_000;
  else if (tf === "1d") span = limit * size * 1.6 + 10 * 86_400_000;
  // ~16 trading hours a day, five days a week, plus thin names that skip bars.
  else span = limit * size * 5 + 4 * 86_400_000;
  return Math.max(HISTORY_FLOOR_MS, endMs - span);
}

/** Union by bar time, oldest first; on a clash the later list wins. */
export function mergeBars(...lists: Bar[][]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const list of lists) for (const bar of list) byTime.set(bar.time, bar);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Append real-time IEX bars after the delayed SIP ones. The bar where the two
 * meet keeps SIP's open and volume and takes IEX's newer close and extremes;
 * later bars are IEX's alone (their volume is IEX-only, a few % of the tape).
 */
export function mergeIexTail(sip: Bar[], iex: Bar[]): Bar[] {
  if (iex.length === 0) return sip;
  if (sip.length === 0) return iex;
  const last = sip[sip.length - 1]!;
  const out = sip.slice(0, -1);
  const overlap = iex.find((bar) => bar.time === last.time);
  out.push(
    overlap
      ? {
          ...last,
          high: Math.max(last.high, overlap.high),
          low: Math.min(last.low, overlap.low),
          close: overlap.close,
        }
      : last,
  );
  for (const bar of iex) if (bar.time > last.time) out.push(bar);
  return out;
}

/** Keep bars with startMs <= time < endMs, then the newest `limit`. */
export function windowBars(
  bars: Bar[],
  window: { startMs?: number; endMs?: number; limit?: number },
): Bar[] {
  let out = bars.filter((bar) => {
    const ms = bar.time * 1000;
    if (window.startMs != null && ms < window.startMs) return false;
    if (window.endMs != null && ms >= window.endMs) return false;
    return true;
  });
  if (window.limit != null && window.limit > 0 && out.length > window.limit) {
    out = out.slice(out.length - window.limit);
  }
  return out;
}

/** Fold one page of a multi-symbol bars response into the accumulator. */
export function appendBarsPage(
  acc: Map<string, Bar[]>,
  page: Record<string, RawBar[] | null | undefined> | null | undefined,
): void {
  if (!page) return;
  for (const [symbol, rows] of Object.entries(page)) {
    if (!Array.isArray(rows)) continue;
    let list = acc.get(symbol);
    if (!list) {
      list = [];
      acc.set(symbol, list);
    }
    for (const raw of rows) {
      const bar = rawToBar(raw);
      if (isValidBar(bar)) list.push(bar);
    }
  }
}

export class AlpacaError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AlpacaError";
    this.status = status;
  }
}

// ── Client ────────────────────────────────────────────────

export type BarsFeed = "sip" | "iex";
export type SnapshotFeed = "iex" | "delayed_sip" | "sip";

export interface MultiBarsParams {
  symbols: string[];
  timeframe: StockTimeframe;
  startMs: number;
  /** Inclusive. */
  endMs: number;
  feed: BarsFeed;
  sort?: "asc" | "desc";
  /** Stop paging once one symbol has this many (single-symbol queries). */
  maxBars?: number;
  priority: Priority;
}

export interface ChartBarsQuery {
  symbol: string;
  timeframe: StockTimeframe;
  startMs?: number;
  /** Exclusive. */
  endMs?: number;
  limit?: number;
  priority?: Priority;
}

export interface AlpacaClientOptions {
  credentials: AlpacaCredentials;
  dataUrl: string;
  tradingUrls: string[];
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AlpacaClient {
  bars(params: MultiBarsParams): Promise<Map<string, Bar[]>>;
  /** What /stocks-api/bars serves: SIP history plus an IEX tail for intraday. */
  chartBars(query: ChartBarsQuery): Promise<Bar[]>;
  snapshots(symbols: string[], feed: SnapshotFeed, priority?: Priority): Promise<Record<string, RawSnapshot>>;
  /** Every active US equity, from the first trading host that answers. */
  assets(): Promise<RawAsset[]>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export function createAlpacaClient(options: AlpacaClientOptions): AlpacaClient {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const limiter = options.limiter ?? createRateLimiter();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { keyId, secretKey } = options.credentials;
  const headers = {
    "APCA-API-KEY-ID": keyId,
    "APCA-API-SECRET-KEY": secretKey,
    Accept: "application/json",
  };

  /** Belt and braces: no error text ever carries a key. */
  const scrub = (text: string) =>
    text.split(keyId).join("[redacted]").split(secretKey).join("[redacted]");

  async function failure(res: Response): Promise<AlpacaError> {
    let detail = res.statusText || "request failed";
    try {
      const text = (await res.text()).slice(0, 400);
      try {
        const body = JSON.parse(text) as { message?: unknown };
        if (typeof body.message === "string") detail = body.message;
        else if (text) detail = text;
      } catch {
        if (text) detail = text;
      }
    } catch {
      // Body unreadable; keep the status text.
    }
    return new AlpacaError(res.status, scrub(`Alpaca ${res.status}: ${detail}`));
  }

  function retryDelay(res: Response, attempt: number): number {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) {
      const ms = reset * 1000 - now();
      if (ms > 0 && ms < 65_000) return ms + 250;
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
    return 1_000 * 2 ** attempt;
  }

  async function getJson(url: string, priority: Priority | null): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      if (priority) await limiter.acquire(priority);
      let res: Response;
      try {
        res = await doFetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (err) {
        if (attempt < 2) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new AlpacaError(502, scrub(`Alpaca unreachable: ${reason}`));
      }
      if (res.status === 429 && attempt < 4) {
        await sleep(retryDelay(res, attempt));
        continue;
      }
      if (res.status >= 500 && attempt < 2) {
        await sleep(1_000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw await failure(res);
      return res.json();
    }
  }

  async function bars(params: MultiBarsParams): Promise<Map<string, Bar[]>> {
    const acc = new Map<string, Bar[]>();
    if (params.symbols.length === 0 || params.startMs > params.endMs) return acc;
    const pageLimit =
      params.maxBars != null && params.symbols.length === 1
        ? Math.min(MAX_PAGE, Math.max(1, params.maxBars))
        : MAX_PAGE;
    let pageToken: string | null = null;
    do {
      const search = new URLSearchParams({
        symbols: params.symbols.join(","),
        timeframe: ALPACA_TIMEFRAMES[params.timeframe],
        start: toRfc3339(params.startMs),
        end: toRfc3339(params.endMs),
        limit: String(pageLimit),
        adjustment: "all",
        feed: params.feed,
        sort: params.sort ?? "asc",
      });
      if (pageToken) search.set("page_token", pageToken);
      const body = (await getJson(`${options.dataUrl}/v2/stocks/bars?${search}`, params.priority)) as {
        bars?: Record<string, RawBar[] | null> | null;
        next_page_token?: string | null;
      };
      appendBarsPage(acc, body.bars);
      pageToken = body.next_page_token ?? null;
      if (params.maxBars != null && params.symbols.length === 1) {
        const got = acc.get(params.symbols[0]!)?.length ?? 0;
        if (got >= params.maxBars) break;
      }
    } while (pageToken);
    return acc;
  }

  async function chartBars(query: ChartBarsQuery): Promise<Bar[]> {
    const { symbol, timeframe: tf } = query;
    const priority = query.priority ?? "live";
    const nowMs = now();
    const size = TIMEFRAME_MS[tf];
    const want = query.limit ?? (query.startMs == null ? DEFAULT_LIMIT : undefined);
    const sipEnd = clipSipEnd(query.endMs, nowMs);

    let sip: Bar[] = [];
    if (query.startMs != null) {
      if (query.startMs <= sipEnd) {
        const map = await bars({
          symbols: [symbol],
          timeframe: tf,
          startMs: query.startMs,
          endMs: sipEnd,
          feed: "sip",
          priority,
        });
        sip = map.get(symbol) ?? [];
      }
    } else {
      const limit = want ?? DEFAULT_LIMIT;
      const map = await bars({
        symbols: [symbol],
        timeframe: tf,
        startMs: lookbackStartMs(tf, sipEnd, limit),
        endMs: sipEnd,
        feed: "sip",
        sort: "desc",
        maxBars: limit,
        priority,
      });
      sip = (map.get(symbol) ?? []).reverse();
    }

    let out = mergeBars(sip);
    const exclusiveEnd = query.endMs ?? Number.POSITIVE_INFINITY;
    if (isIntraday(tf) && exclusiveEnd > nowMs - SIP_DELAY_MS) {
      const last = out[out.length - 1];
      const iexStart = last ? last.time * 1000 : Math.max(query.startMs ?? 0, nowMs - SIP_DELAY_MS - size);
      const iexEnd = Math.min(exclusiveEnd - 1_000, nowMs);
      if (iexStart <= iexEnd) {
        try {
          const map = await bars({
            symbols: [symbol],
            timeframe: tf,
            startMs: iexStart,
            endMs: iexEnd,
            feed: "iex",
            priority,
          });
          out = mergeIexTail(out, mergeBars(map.get(symbol) ?? []));
        } catch {
          // IEX is a nicety; the delayed SIP bars stand on their own.
        }
      }
    }
    return windowBars(out, { startMs: query.startMs, endMs: query.endMs, limit: want });
  }

  async function snapshots(
    symbols: string[],
    feed: SnapshotFeed,
    priority: Priority = "live",
  ): Promise<Record<string, RawSnapshot>> {
    const out: Record<string, RawSnapshot> = {};
    for (let i = 0; i < symbols.length; i += 100) {
      const chunk = symbols.slice(i, i + 100);
      const search = new URLSearchParams({ symbols: chunk.join(","), feed });
      const body = (await getJson(`${options.dataUrl}/v2/stocks/snapshots?${search}`, priority)) as
        | Record<string, RawSnapshot | null>
        | { snapshots?: Record<string, RawSnapshot | null> };
      const map = ("snapshots" in body && body.snapshots ? body.snapshots : body) as Record<
        string,
        RawSnapshot | null
      >;
      for (const [symbol, snap] of Object.entries(map)) if (snap) out[symbol] = snap;
    }
    return out;
  }

  async function assets(): Promise<RawAsset[]> {
    let lastError: unknown = null;
    for (const base of options.tradingUrls) {
      try {
        const body = await getJson(`${base}/v2/assets?status=active&asset_class=us_equity`, null);
        if (Array.isArray(body)) return body as RawAsset[];
        lastError = new AlpacaError(502, "Alpaca assets: unexpected response");
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new AlpacaError(502, "Alpaca assets unavailable");
  }

  return { bars, chartBars, snapshots, assets };
}

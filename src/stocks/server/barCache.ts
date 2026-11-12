import { join } from "node:path";
import type { Bar } from "../types.ts";
import type { StockTimeframe } from "../data/time.ts";
import { SIP_DELAY_MS, mergeBars, type AlpacaClient } from "./alpaca.ts";
import { diskIO, type FileIO } from "./files.ts";
import type { Priority } from "./rateLimit.ts";

/**
 * Disk cache of SIP bars per symbol and timeframe, topped up incrementally like
 * trading-script/backtest/data.py: only bars from the end of the cache onward
 * are fetched and merged in, re-grabbing the newest cached ones so a bar that
 * was still forming when it was cached settles.
 *
 * One difference: data.py keeps old `adjustment=all` prices forever. Here the
 * re-grabbed overlap is compared with the cache, and a mismatch on a settled
 * bar (a split or dividend re-adjusted history) refetches the whole series, so
 * the cache always equals a fresh pull.
 */

export interface CachedSeries {
  symbol: string;
  timeframe: StockTimeframe;
  /** Epoch ms the series was requested from. */
  startMs: number;
  bars: Bar[];
  updatedAt: number;
}

interface CacheFile {
  v: 1;
  symbol: string;
  timeframe: StockTimeframe;
  start: string;
  feed: "sip";
  adjustment: "all";
  updatedAt: string;
  /** [time, open, high, low, close, volume] */
  bars: [number, number, number, number, number, number][];
}

// ── Pure helpers (exported for tests) ─────────────────────

/** Where a top-up starts: the second-newest cached bar, so the newest can settle. */
export function topUpStartMs(bars: Bar[]): number | null {
  if (bars.length === 0) return null;
  const anchor = bars.length >= 2 ? bars[bars.length - 2]! : bars[bars.length - 1]!;
  return anchor.time * 1000;
}

function differs(a: number, b: number): boolean {
  return Math.abs(a - b) > Math.max(1e-6, Math.abs(a) * 1e-4);
}

/**
 * True when a settled bar in the overlap no longer matches the cache, i.e.
 * Alpaca re-adjusted history. The newest cached bar is skipped: it may have
 * been cached mid-session.
 */
export function adjustmentChanged(cached: Bar[], fresh: Bar[]): boolean {
  if (cached.length < 2 || fresh.length === 0) return false;
  const newest = cached[cached.length - 1]!.time;
  const byTime = new Map(cached.map((bar) => [bar.time, bar]));
  for (const bar of fresh) {
    if (bar.time >= newest) continue;
    const old = byTime.get(bar.time);
    if (!old) continue;
    if (differs(old.close, bar.close) || differs(old.open, bar.open)) return true;
  }
  return false;
}

/** Cached bars plus the fresh ones; fresh wins where they overlap. */
export function mergeTopUp(cached: Bar[], fresh: Bar[]): Bar[] {
  return mergeBars(cached, fresh);
}

function sameBars(a: Bar[], b: Bar[]): boolean {
  if (a.length !== b.length) return false;
  const x = a[a.length - 1];
  const y = b[b.length - 1];
  if (!x || !y) return true;
  return (
    x.time === y.time && x.close === y.close && x.high === y.high && x.low === y.low && x.volume === y.volume
  );
}

export function encodeCacheFile(series: CachedSeries): string {
  const file: CacheFile = {
    v: 1,
    symbol: series.symbol,
    timeframe: series.timeframe,
    start: new Date(series.startMs).toISOString(),
    feed: "sip",
    adjustment: "all",
    updatedAt: new Date(series.updatedAt).toISOString(),
    bars: series.bars.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume]),
  };
  return JSON.stringify(file);
}

export function decodeCacheFile(text: string): CachedSeries | null {
  try {
    const file = JSON.parse(text) as Partial<CacheFile>;
    if (file.v !== 1 || !Array.isArray(file.bars) || !file.symbol || !file.timeframe) return null;
    return {
      symbol: file.symbol,
      timeframe: file.timeframe,
      startMs: Date.parse(file.start ?? ""),
      updatedAt: Date.parse(file.updatedAt ?? "") || 0,
      bars: file.bars.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume })),
    };
  } catch {
    return null;
  }
}

// ── Store ─────────────────────────────────────────────────

export interface EnsureResult {
  bars: Map<string, Bar[]>;
  failures: Map<string, string>;
  /** Alpaca requests this call made. */
  requests: number;
}

export interface BarStore {
  /** Bring each symbol's cache up to date (fetching it whole when missing) and return it. */
  ensure(symbols: string[], tf: StockTimeframe, startMs: number, priority: Priority): Promise<EnsureResult>;
  /** Cached bars without touching the network. */
  peek(symbol: string, tf: StockTimeframe): Promise<Bar[] | null>;
}

export interface BarStoreOptions {
  dir: string;
  client: () => AlpacaClient;
  now?: () => number;
  files?: FileIO;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createBarStore(options: BarStoreOptions): BarStore {
  const now = options.now ?? Date.now;
  const files = options.files ?? diskIO;
  const memory = new Map<string, CachedSeries>();
  const pathOf = (symbol: string, tf: StockTimeframe) =>
    join(options.dir, "bars", tf, `${symbol.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

  async function load(symbol: string, tf: StockTimeframe): Promise<CachedSeries | null> {
    const key = `${tf}:${symbol}`;
    const hit = memory.get(key);
    if (hit) return hit;
    try {
      const series = decodeCacheFile(await files.read(pathOf(symbol, tf)));
      if (series) memory.set(key, series);
      return series;
    } catch {
      return null;
    }
  }

  async function save(series: CachedSeries): Promise<void> {
    memory.set(`${series.timeframe}:${series.symbol}`, series);
    try {
      await files.write(pathOf(series.symbol, series.timeframe), encodeCacheFile(series));
    } catch (err) {
      console.warn(`[stocks] could not write bar cache for ${series.symbol} ${series.timeframe}: ${describe(err)}`);
    }
  }

  async function ensure(
    symbols: string[],
    tf: StockTimeframe,
    startMs: number,
    priority: Priority,
  ): Promise<EnsureResult> {
    const result: EnsureResult = { bars: new Map(), failures: new Map(), requests: 0 };
    const endMs = now() - SIP_DELAY_MS;
    const cached = new Map<string, CachedSeries>();
    const full: string[] = [];
    for (const symbol of symbols) {
      const series = await load(symbol, tf);
      if (series && series.bars.length > 0 && series.startMs <= startMs) cached.set(symbol, series);
      else full.push(symbol);
    }

    const fetchFull = async (list: string[]) => {
      if (list.length === 0) return;
      try {
        result.requests += 1;
        const map = await options.client().bars({ symbols: list, timeframe: tf, startMs, endMs, feed: "sip", priority });
        for (const symbol of list) {
          const bars = mergeBars(map.get(symbol) ?? []);
          if (bars.length === 0) {
            result.failures.set(symbol, "Alpaca returned no bars");
            continue;
          }
          await save({ symbol, timeframe: tf, startMs, bars, updatedAt: now() });
          result.bars.set(symbol, bars);
        }
      } catch (err) {
        for (const symbol of list) result.failures.set(symbol, describe(err));
      }
    };

    await fetchFull(full);

    const topUp = [...cached.keys()];
    if (topUp.length > 0) {
      const from = Math.min(...topUp.map((s) => topUpStartMs(cached.get(s)!.bars) ?? startMs));
      const refetch: string[] = [];
      try {
        result.requests += 1;
        const map = await options.client().bars({
          symbols: topUp,
          timeframe: tf,
          startMs: from,
          endMs,
          feed: "sip",
          priority,
        });
        for (const symbol of topUp) {
          const series = cached.get(symbol)!;
          const fresh = mergeBars(map.get(symbol) ?? []);
          if (adjustmentChanged(series.bars, fresh)) {
            refetch.push(symbol);
            continue;
          }
          const merged = mergeTopUp(series.bars, fresh);
          if (!sameBars(merged, series.bars)) {
            await save({ ...series, bars: merged, updatedAt: now() });
          }
          result.bars.set(symbol, merged);
        }
      } catch (err) {
        for (const symbol of topUp) result.failures.set(symbol, describe(err));
      }
      await fetchFull(refetch);
    }
    return result;
  }

  return {
    ensure,
    async peek(symbol, tf) {
      return (await load(symbol, tf))?.bars ?? null;
    },
  };
}

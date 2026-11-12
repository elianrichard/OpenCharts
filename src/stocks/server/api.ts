import { join } from "node:path";
import type { AssetInfo, Bar, ListEntry, StockSnapshot } from "../types.ts";
import { holdingsFromJournal } from "../data/holdings.ts";
import { STOCKS_ENDPOINTS } from "../data/protocol.ts";
import {
  TIMEFRAME_MS,
  etDateKey,
  isIntraday,
  isStockTimeframe,
  marketSession,
  type StockTimeframe,
} from "../data/time.ts";
import {
  AlpacaError,
  DEFAULT_LIMIT,
  SIP_DELAY_MS,
  createAlpacaClient,
  mergeBars,
  windowBars,
  type AlpacaClient,
  type RawAsset,
  type RawSnapshot,
} from "./alpaca.ts";
import { createBarStore, type BarStore } from "./barCache.ts";
import { missingKeysMessage, type StocksConfig } from "./config.ts";
import { parseList } from "./list.ts";
import { createRateLimiter, type RateLimiter } from "./rateLimit.ts";
import { createScanService, type ScanFns, type ScanService } from "./scans.ts";
import { averageVolume, buildSnapshot } from "./snapshot.ts";
import { diskIO, type FileIO } from "./files.ts";

/**
 * The /stocks-api routes, independent of any HTTP server: `handle(route,
 * params)` returns a status and a JSON body. alpacaProxy.ts mounts it on
 * Vite's dev and preview servers.
 */

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface ApiResult {
  status: number;
  body: unknown;
}

export interface StocksApiOptions {
  /** Re-read when keys are missing, so adding them needs no restart. */
  loadConfig: () => Promise<StocksConfig>;
  loadScans: () => Promise<ScanFns>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  limiter?: RateLimiter;
  files?: FileIO;
}

export interface StocksApi {
  handle(route: string, params: URLSearchParams): Promise<ApiResult>;
}

const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const MAX_SYMBOLS = 500;
const ASSETS_TTL_MS = 7 * 86_400_000;

export function parseSymbol(raw: string | null): string {
  const symbol = (raw ?? "").trim().toUpperCase().replace(/-/g, ".");
  if (!SYMBOL.test(symbol)) throw new HttpError(400, `Invalid symbol "${raw ?? ""}"`);
  return symbol;
}

export function parseSymbols(raw: string | null): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseSymbol);
  const unique = [...new Set(list)];
  if (unique.length > MAX_SYMBOLS) throw new HttpError(400, `At most ${MAX_SYMBOLS} symbols per request`);
  return unique;
}

/** Epoch ms from epoch ms, epoch seconds (< 1e11) or an ISO date. */
export function parseTime(raw: string | null, name: string): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const text = raw.trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new HttpError(400, `Invalid ${name} "${raw}"`);
  return ms;
}

function parseLimit(raw: string | null): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50_000) throw new HttpError(400, "limit must be an integer from 1 to 50000");
  return n;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Memo {
  expires: number;
  value: Promise<unknown>;
}

interface AvgEntry {
  day: string;
  value: number | null;
  retryAt: number;
}

interface HeadEntry {
  bars: Bar[];
  /** When the full history was last loaded (tail refreshes keep it). */
  fetchedAt: number;
}

const HEAD_REUSE_MS = 30 * 60_000;

interface AssetsIndex {
  fetchedAt: number;
  byId: Record<string, [name: string, exchange: string, tradable: boolean]>;
}

export function createStocksApi(options: StocksApiOptions): StocksApi {
  const now = options.now ?? Date.now;
  const limiter = options.limiter ?? createRateLimiter({ now });
  const files = options.files ?? diskIO;

  let config: StocksConfig | null = null;
  let configAt = 0;
  let client: AlpacaClient | null = null;
  let clientKey = "";
  let barStore: BarStore | null = null;
  let scans: ScanService | null = null;
  const memo = new Map<string, Memo>();
  const heads = new Map<string, HeadEntry>();
  const avgVolumes = new Map<string, AvgEntry>();
  let avgFetching = false;
  let assetsIndex: AssetsIndex | null = null;
  let assetsRetryAt = 0;

  async function getConfig(): Promise<StocksConfig> {
    const stale = !config || (!config.credentials && now() - configAt > 5_000);
    if (stale) {
      config = await options.loadConfig();
      configAt = now();
      const key = config.credentials ? `${config.credentials.keyId}\u0000${config.credentials.secretKey}` : "";
      if (key !== clientKey) {
        clientKey = key;
        client = config.credentials
          ? createAlpacaClient({
              credentials: config.credentials,
              dataUrl: config.dataUrl,
              tradingUrls: config.tradingUrls,
              fetchImpl: options.fetchImpl,
              limiter,
              now,
            })
          : null;
      }
      if (!barStore) {
        const cacheDir = config.cacheDir;
        barStore = createBarStore({ dir: cacheDir, client: requireClient, now, files });
        scans = createScanService({
          bars: barStore,
          loadUniverse: readUniverse,
          loadScans: options.loadScans,
          reportPath: join(cacheDir, "scan-report.json"),
          now,
          files,
        });
      }
    }
    return config!;
  }

  function requireClient(): AlpacaClient {
    if (!client) throw new HttpError(503, missingKeysMessage(config!));
    return client;
  }

  function memoize<T>(key: string, ttlMs: number, make: () => Promise<T>): Promise<T> {
    const t = now();
    const hit = memo.get(key);
    if (hit && hit.expires > t) return hit.value as Promise<T>;
    const value = make();
    const entry: Memo = { expires: Number.POSITIVE_INFINITY, value };
    memo.set(key, entry);
    // The TTL runs from completion (slow pulls stay shared while in flight);
    // failures are not cached.
    value.then(
      () => {
        entry.expires = now() + ttlMs;
      },
      () => {
        if (memo.get(key) === entry) memo.delete(key);
      },
    );
    if (memo.size > 300) {
      for (const [k, m] of memo) if (m.expires <= t) memo.delete(k);
    }
    return value;
  }

  async function readUniverse(): Promise<ListEntry[]> {
    const cfg = await getConfig();
    let text: string;
    try {
      text = await files.read(cfg.listPath);
    } catch {
      throw new HttpError(404, `list.txt not found at ${cfg.listPath} (set STOCKS_LIST_PATH)`);
    }
    return parseList(text);
  }

  // ── avgVolume30 ──────────────────────────────────────────

  function refreshAvgVolumes(symbols: string[]): void {
    if (avgFetching || symbols.length === 0 || !client) return;
    avgFetching = true;
    const t = now();
    const day = etDateKey(t);
    client
      .bars({
        symbols,
        timeframe: "1d",
        startMs: t - 75 * 86_400_000,
        endMs: t - SIP_DELAY_MS,
        feed: "sip",
        priority: "live",
      })
      .then((map) => {
        for (const symbol of symbols) {
          const bars = mergeBars(map.get(symbol) ?? []);
          avgVolumes.set(symbol, { day, value: averageVolume(bars, t), retryAt: 0 });
        }
      })
      .catch(() => {
        for (const symbol of symbols) avgVolumes.set(symbol, { day, value: null, retryAt: t + 10 * 60_000 });
      })
      .finally(() => {
        avgFetching = false;
      });
  }

  async function avgVolumeEntries(symbols: string[]): Promise<Map<string, AvgEntry>> {
    const t = now();
    const day = etDateKey(t);
    const out = new Map<string, AvgEntry>();
    const missing: string[] = [];
    for (const symbol of symbols) {
      const hit = avgVolumes.get(symbol);
      if (hit && hit.day === day && (hit.value != null || hit.retryAt > t)) {
        out.set(symbol, hit);
        continue;
      }
      const cached = barStore ? await barStore.peek(symbol, "1d") : null;
      const value = averageVolume(cached, t);
      // A cache last topped up more than a week ago is too old to trust.
      const fresh = cached && cached.length > 0 && t - cached[cached.length - 1]!.time * 1000 < 7 * 86_400_000;
      if (value != null && fresh) {
        const entry = { day, value, retryAt: 0 };
        avgVolumes.set(symbol, entry);
        out.set(symbol, entry);
      } else {
        missing.push(symbol);
      }
    }
    refreshAvgVolumes(missing);
    return out;
  }

  // ── Assets ──────────────────────────────────────────────

  async function loadAssets(cfg: StocksConfig): Promise<AssetsIndex | null> {
    const t = now();
    if (assetsIndex && t - assetsIndex.fetchedAt < ASSETS_TTL_MS) return assetsIndex;
    const path = join(cfg.cacheDir, "assets.json");
    if (!assetsIndex) {
      try {
        const disk = JSON.parse(await files.read(path)) as AssetsIndex;
        if (disk && typeof disk.fetchedAt === "number" && disk.byId) assetsIndex = disk;
      } catch {
        // Not cached yet.
      }
      if (assetsIndex && t - assetsIndex.fetchedAt < ASSETS_TTL_MS) return assetsIndex;
    }
    if (!client || t < assetsRetryAt) return assetsIndex;
    try {
      const rows: RawAsset[] = await client.assets();
      const byId: AssetsIndex["byId"] = {};
      for (const row of rows) {
        if (row && typeof row.symbol === "string") {
          byId[row.symbol.toUpperCase()] = [row.name || row.symbol, row.exchange || "", row.tradable !== false];
        }
      }
      assetsIndex = { fetchedAt: t, byId };
      await files.write(path, JSON.stringify(assetsIndex));
    } catch (err) {
      assetsRetryAt = t + 10 * 60_000;
      console.warn(`[stocks] Alpaca assets unavailable, using list.txt names: ${describe(err)}`);
    }
    return assetsIndex;
  }

  // ── Routes ──────────────────────────────────────────────

  async function bars(params: URLSearchParams): Promise<Bar[]> {
    await getConfig();
    const symbol = parseSymbol(params.get("symbol"));
    const timeframe = params.get("timeframe") ?? "";
    if (!isStockTimeframe(timeframe)) {
      throw new HttpError(400, `timeframe must be one of ${Object.keys(TIMEFRAME_MS).join(", ")}`);
    }
    const startMs = parseTime(params.get("start"), "start");
    const endMs = parseTime(params.get("end"), "end");
    const limit = parseLimit(params.get("limit"));
    if (startMs != null && endMs != null && startMs >= endMs) return [];
    const alpaca = requireClient();
    const t = now();
    const settled = endMs != null && endMs < t - SIP_DELAY_MS - 60_000;
    const head = startMs == null && endMs == null;
    const ttl = settled
      ? 10 * 60_000
      : head && marketSession(t) === "closed"
        ? 60_000
        : isIntraday(timeframe)
          ? 4_000
          : 20_000;
    return memoize(`bars:${symbol}:${timeframe}:${startMs ?? ""}:${endMs ?? ""}:${limit ?? ""}`, ttl, () =>
      head
        ? headBars(alpaca, symbol, timeframe, limit)
        : alpaca.chartBars({ symbol, timeframe, startMs, endMs, limit }),
    );
  }

  /**
   * "Newest N bars" requests repeat: the chart refetches its history every few
   * minutes, and every 30 s once its last bar looks stale (after hours). Keep
   * the last answer and only re-read its tail, from before the IEX-filled
   * minutes so delayed SIP replaces them once it has them. A full reload every
   * HEAD_REUSE_MS picks up any re-adjusted history.
   */
  async function headBars(alpaca: AlpacaClient, symbol: string, tf: StockTimeframe, limit?: number): Promise<Bar[]> {
    const key = `${symbol}:${tf}:${limit ?? ""}`;
    const t = now();
    const prev = heads.get(key);
    let entry: HeadEntry;
    if (prev && prev.bars.length >= 2 && t - prev.fetchedAt < HEAD_REUSE_MS) {
      const from = Math.min(
        prev.bars[prev.bars.length - 2]!.time * 1000,
        t - SIP_DELAY_MS - TIMEFRAME_MS[tf],
      );
      const fresh = await alpaca.chartBars({ symbol, timeframe: tf, startMs: from });
      const merged = mergeBars(prev.bars.filter((b) => b.time * 1000 < from), fresh);
      entry = { bars: windowBars(merged, { limit: limit ?? DEFAULT_LIMIT }), fetchedAt: prev.fetchedAt };
    } else {
      entry = { bars: await alpaca.chartBars({ symbol, timeframe: tf, limit }), fetchedAt: t };
    }
    heads.delete(key);
    heads.set(key, entry);
    while (heads.size > 40) {
      const oldest = heads.keys().next().value;
      if (oldest === undefined) break;
      heads.delete(oldest);
    }
    return entry.bars;
  }

  async function snapshots(params: URLSearchParams): Promise<Record<string, StockSnapshot>> {
    await getConfig();
    const symbols = parseSymbols(params.get("symbols"));
    if (symbols.length === 0) throw new HttpError(400, "symbols is required, e.g. ?symbols=AAPL,MSFT");
    const alpaca = requireClient();
    const key = `snapshots:${[...symbols].sort().join(",")}`;
    return memoize(key, 2_000, async () => {
      const [iex, sip] = await Promise.allSettled([
        alpaca.snapshots(symbols, "iex"),
        alpaca.snapshots(symbols, "delayed_sip"),
      ]);
      if (iex.status === "rejected" && sip.status === "rejected") throw iex.reason;
      const iexMap: Record<string, RawSnapshot> = iex.status === "fulfilled" ? iex.value : {};
      const sipMap: Record<string, RawSnapshot> = sip.status === "fulfilled" ? sip.value : {};
      const avg = await avgVolumeEntries(symbols);
      const t = now();
      const out: Record<string, StockSnapshot> = {};
      for (const symbol of symbols) {
        if (!iexMap[symbol] && !sipMap[symbol]) continue;
        const entry = avg.get(symbol);
        out[symbol] = buildSnapshot({
          symbol,
          iex: iexMap[symbol],
          sip: sipMap[symbol],
          nowMs: t,
          avgVolume30: entry?.value ?? null,
        });
      }
      return out;
    });
  }

  async function assets(params: URLSearchParams): Promise<AssetInfo[]> {
    const cfg = await getConfig();
    let universe: ListEntry[] = [];
    try {
      universe = await readUniverse();
    } catch {
      // Names still resolve through Alpaca without list.txt.
    }
    const exchangeOf = new Map(universe.map((e) => [e.symbol, e.exchange]));
    const requested = params.get("symbols");
    const symbols = requested ? parseSymbols(requested) : universe.map((e) => e.symbol);
    const index = await loadAssets(cfg);
    return symbols.map((symbol) => {
      const hit = index?.byId[symbol];
      return hit
        ? { symbol, name: hit[0], exchange: hit[1], tradable: hit[2] }
        : { symbol, name: symbol, exchange: exchangeOf.get(symbol) ?? "", tradable: true };
    });
  }

  async function holdings() {
    const cfg = await getConfig();
    let text: string;
    try {
      text = await files.read(cfg.journalPath);
    } catch {
      throw new HttpError(404, `journal.json not found at ${cfg.journalPath} (set STOCKS_JOURNAL_PATH)`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new HttpError(422, `journal.json is not valid JSON: ${describe(err)}`);
    }
    return holdingsFromJournal(raw);
  }

  async function scanReport(params: URLSearchParams): Promise<ApiResult> {
    await getConfig();
    const service = scans!;
    if (!client) {
      const cached = await service.peek();
      if (cached) return { status: 200, body: cached };
      requireClient();
    }
    const refresh = params.get("refresh") === "1" || params.get("refresh") === "true";
    const wait = params.get("wait") !== "0" && params.get("wait") !== "false";
    const report = await service.get({ refresh, wait });
    if (!report) return { status: 202, body: await service.status() };
    return { status: 200, body: report };
  }

  async function scanStatus() {
    await getConfig();
    return scans!.status();
  }

  const routes: Record<string, (params: URLSearchParams) => Promise<unknown>> = {
    [STOCKS_ENDPOINTS.bars]: bars,
    [STOCKS_ENDPOINTS.snapshots]: snapshots,
    [STOCKS_ENDPOINTS.assets]: assets,
    [STOCKS_ENDPOINTS.list]: () => readUniverse(),
    [STOCKS_ENDPOINTS.holdings]: () => holdings(),
    [STOCKS_ENDPOINTS.scanStatus]: () => scanStatus(),
  };

  return {
    async handle(route, params) {
      const path = route.replace(/\/+$/, "") || "/";
      try {
        if (path === STOCKS_ENDPOINTS.scans) return await scanReport(params);
        const handler = routes[path];
        if (!handler) return { status: 404, body: { error: `Unknown endpoint ${path}` } };
        return { status: 200, body: await handler(params) };
      } catch (err) {
        if (err instanceof HttpError || err instanceof AlpacaError) {
          return { status: err.status, body: { error: err.message } };
        }
        return { status: 500, body: { error: describe(err) } };
      }
    },
  };
}

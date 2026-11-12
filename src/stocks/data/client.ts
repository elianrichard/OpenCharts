import type { AssetInfo, Bar, HoldingsReport, ListEntry, ScanReport, StockSnapshot } from "../types.ts";
import { STOCKS_API_PREFIX, STOCKS_ENDPOINTS, type BarsQuery, type ScanStatus } from "./protocol.ts";

/**
 * Typed browser wrappers for the /stocks-api endpoints served by the Vite
 * plugin in src/stocks/server/. The browser never talks to Alpaca directly and
 * never sees its keys.
 */

export type { BarsQuery, ScanStatus };

export class StocksApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StocksApiError";
    this.status = status;
  }
}

export interface StocksClientOptions {
  /** Defaults to "/stocks-api". */
  baseUrl?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface StocksClient {
  getBars(query: BarsQuery, options?: RequestOptions): Promise<Bar[]>;
  getSnapshots(symbols: string[], options?: RequestOptions): Promise<Record<string, StockSnapshot>>;
  /** Company names and exchanges; every list.txt symbol when `symbols` is omitted. */
  getAssets(symbols?: string[], options?: RequestOptions): Promise<AssetInfo[]>;
  getList(options?: RequestOptions): Promise<ListEntry[]>;
  getHoldings(options?: RequestOptions): Promise<HoldingsReport>;
  /**
   * The scan report. Resolves once a fresh report exists, which can take a
   * minute or two on the first run (watch `getScanStatus`). `refresh` forces a
   * rerun; `wait: false` returns the existing report, or null while the first
   * one is still being computed.
   */
  getScans(options?: RequestOptions & { refresh?: boolean; wait?: boolean }): Promise<ScanReport | null>;
  getScanStatus(options?: RequestOptions): Promise<ScanStatus>;
}

/** Query string for /bars; exported for tests. */
export function barsSearch(query: BarsQuery): URLSearchParams {
  const params = new URLSearchParams({ symbol: query.symbol, timeframe: query.timeframe });
  if (query.startMs != null) params.set("start", String(Math.floor(query.startMs)));
  if (query.endMs != null) params.set("end", String(Math.floor(query.endMs)));
  if (query.limit != null) params.set("limit", String(Math.max(1, Math.floor(query.limit))));
  return params;
}

export function createStocksClient(options: StocksClientOptions = {}): StocksClient {
  const base = (options.baseUrl ?? STOCKS_API_PREFIX).replace(/\/+$/, "");
  const doFetch = (input: string, init?: RequestInit) =>
    (options.fetchImpl ?? globalThis.fetch.bind(globalThis))(input, init);

  async function request<T>(
    path: string,
    params: URLSearchParams | null,
    init: RequestOptions = {},
  ): Promise<{ status: number; body: T }> {
    const qs = params && [...params.keys()].length > 0 ? `?${params.toString()}` : "";
    let res: Response;
    try {
      res = await doFetch(`${base}${path}${qs}`, { signal: init.signal, headers: { Accept: "application/json" } });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new StocksApiError(0, `Stocks API unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Non-JSON (e.g. the SPA fallback when the plugin is not installed).
    }
    if (!res.ok) {
      const message =
        body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Stocks API ${res.status} ${res.statusText}`.trim();
      throw new StocksApiError(res.status, message);
    }
    if (body === null) {
      throw new StocksApiError(
        res.status,
        "Stocks API returned no JSON. Is the alpacaProxy plugin registered in vite.config.ts?",
      );
    }
    return { status: res.status, body: body as T };
  }

  const get = async <T>(path: string, params: URLSearchParams | null, init?: RequestOptions) =>
    (await request<T>(path, params, init)).body;

  return {
    getBars: (query, init) => get<Bar[]>(STOCKS_ENDPOINTS.bars, barsSearch(query), init),

    getSnapshots: async (symbols, init) => {
      const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
      if (unique.length === 0) return {};
      return get<Record<string, StockSnapshot>>(
        STOCKS_ENDPOINTS.snapshots,
        new URLSearchParams({ symbols: unique.join(",") }),
        init,
      );
    },

    getAssets: (symbols, init) =>
      get<AssetInfo[]>(
        STOCKS_ENDPOINTS.assets,
        symbols && symbols.length > 0 ? new URLSearchParams({ symbols: symbols.join(",") }) : null,
        init,
      ),

    getList: (init) => get<ListEntry[]>(STOCKS_ENDPOINTS.list, null, init),

    getHoldings: (init) => get<HoldingsReport>(STOCKS_ENDPOINTS.holdings, null, init),

    getScans: async (init = {}) => {
      const params = new URLSearchParams();
      if (init.refresh) params.set("refresh", "1");
      if (init.wait === false) params.set("wait", "0");
      const { status, body } = await request<ScanReport | ScanStatus>(STOCKS_ENDPOINTS.scans, params, init);
      return status === 202 ? null : (body as ScanReport);
    },

    getScanStatus: (init) => get<ScanStatus>(STOCKS_ENDPOINTS.scanStatus, null, init),
  };
}

/** Shared client for the app. */
export const stocksApi: StocksClient = createStocksClient();

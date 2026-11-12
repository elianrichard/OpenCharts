/**
 * Wire contract between src/stocks/data/client.ts (browser) and the dev-server
 * plugin in src/stocks/server/. Type-only plus constants; safe to import from
 * either side.
 */

export const STOCKS_API_PREFIX = "/stocks-api";

export const STOCKS_ENDPOINTS = {
  bars: "/bars",
  snapshots: "/snapshots",
  assets: "/assets",
  list: "/list",
  holdings: "/holdings",
  scans: "/scans",
  scanStatus: "/scans/status",
} as const;

export interface BarsQuery {
  symbol: string;
  /** "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w" */
  timeframe: string;
  /** Inclusive lower bound, epoch ms. */
  startMs?: number;
  /** Exclusive upper bound, epoch ms. */
  endMs?: number;
  /** Most recent N bars inside the window. */
  limit?: number;
}

export interface ScanStatus {
  running: boolean;
  /** Symbols finished in the current (or last) run. */
  done: number;
  total: number;
  /** ISO time the current (or last) run started. */
  startedAt: string | null;
  /** ISO time the last run finished. */
  finishedAt?: string | null;
  /** generatedAt of the report the endpoint currently serves. */
  reportGeneratedAt?: string | null;
  /** True when the served report is from an earlier trading session. */
  stale?: boolean;
  /** Why the last run failed outright, if it did. */
  error?: string | null;
}

/** Every error response body. */
export interface ApiErrorBody {
  error: string;
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { AssetInfo, Bar, HoldingsReport, ListEntry, ScanReport } from "../types.ts";

/**
 * Server data for the workspace, from the dev-server endpoints in
 * src/stocks/server. Everything here is read-only.
 */

export class StocksApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* not JSON */
    }
    throw new StocksApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export interface ScanStatus {
  running: boolean;
  done: number;
  total: number;
  startedAt: string | null;
}

export const stockKeys = {
  scans: ["stocks", "scans"] as const,
  scanStatus: ["stocks", "scans", "status"] as const,
  holdings: ["stocks", "holdings"] as const,
  list: ["stocks", "list"] as const,
  assets: (symbols: string) => ["stocks", "assets", symbols] as const,
  history: (symbol: string, timeframe: string) => ["stocks", "history", symbol, timeframe] as const,
};

export function useScanStatus(enabled: boolean) {
  return useQuery({
    queryKey: stockKeys.scanStatus,
    queryFn: () => getJson<ScanStatus>("/stocks-api/scans/status"),
    enabled,
    refetchInterval: (q) => (q.state.data?.running ? 1500 : 15_000),
  });
}

/**
 * The 150-symbol scan. The server caches it per trading day; while a run is
 * in progress the status endpoint is polled and the report refetched when
 * the run finishes.
 */
export function useScanReport() {
  const qc = useQueryClient();
  const report = useQuery({
    queryKey: stockKeys.scans,
    queryFn: () => getJson<ScanReport>("/stocks-api/scans"),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    retry: 1,
  });
  const status = useScanStatus(true);
  const running = status.data?.running ?? false;
  useEffect(() => {
    if (!running) void qc.invalidateQueries({ queryKey: stockKeys.scans, exact: true });
  }, [running, qc]);
  return { report, status };
}

export async function refreshScans(qc: ReturnType<typeof useQueryClient>): Promise<void> {
  await getJson<unknown>("/stocks-api/scans?refresh=1&wait=0").catch(() => undefined);
  await qc.invalidateQueries({ queryKey: ["stocks", "scans"] });
}

export function useHoldings() {
  return useQuery({
    queryKey: stockKeys.holdings,
    queryFn: () => getJson<HoldingsReport>("/stocks-api/holdings"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function useUniverse() {
  return useQuery({
    queryKey: stockKeys.list,
    queryFn: () => getJson<ListEntry[]>("/stocks-api/list"),
    staleTime: Infinity,
  });
}

export function useAssets(symbols: string[]) {
  const key = [...symbols].sort().join(",");
  return useQuery({
    queryKey: stockKeys.assets(key),
    queryFn: () => getJson<AssetInfo[]>(`/stocks-api/assets?symbols=${encodeURIComponent(key)}`),
    enabled: symbols.length > 0,
    staleTime: Infinity,
  });
}

/** Since the Alpaca SIP history starts (2016), the span the Python scans use. */
export const HISTORY_START: Record<"1d" | "1w", string> = {
  "1d": "2016-01-01",
  "1w": "2016-01-01",
};

/** Full daily or weekly history for one symbol (strategy tester, signal markers). */
export function useHistory(symbol: string, timeframe: "1d" | "1w") {
  return useQuery({
    queryKey: stockKeys.history(symbol, timeframe),
    queryFn: () =>
      getJson<Bar[]>(
        `/stocks-api/bars?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&start=${HISTORY_START[timeframe]}`,
      ),
    enabled: !!symbol,
    staleTime: 10 * 60_000,
    refetchInterval: 15 * 60_000,
  });
}

export function fetchBars(symbol: string, timeframe: string, limit: number): Promise<Bar[]> {
  return getJson<Bar[]>(
    `/stocks-api/bars?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=${limit}`,
  );
}

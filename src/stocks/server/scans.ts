import type { Bar, DivScanRow, ListEntry, ScanFailure, ScanReport, StochScanRow } from "../types.ts";
import type { ScanStatus } from "../data/protocol.ts";
import { scanEpoch } from "../data/time.ts";
import type { BarStore } from "./barCache.ts";
import { diskIO, type FileIO } from "./files.ts";

/**
 * Runs the two validated scans over list.txt, as railway/scan.py does:
 *   - Divergence buy on daily bars since 2016-01-01 (div_scan.py START)
 *   - Stoch RSI 4-cross on weekly bars since 2021-01-01 (stoch_scan.py STARTS["1w"])
 *
 * Bars come from the disk cache, topped up with multi-symbol requests in
 * chunks so progress moves and other endpoints keep their share of the rate
 * budget. The report is cached on disk and recomputed when a new session's
 * data exists (see scanEpoch) or on refresh.
 */

export interface ScanFns {
  scanDivergence(symbol: string, dailyBars: Bar[]): DivScanRow;
  scanStoch(symbol: string, weeklyBars: Bar[], nowMs: number): StochScanRow;
}

export const DIV_START_MS = Date.UTC(2016, 0, 1);
export const STOCH_START_MS = Date.UTC(2021, 0, 1);

export interface ScanServiceOptions {
  bars: BarStore;
  loadUniverse: () => Promise<ListEntry[]>;
  loadScans: () => Promise<ScanFns>;
  reportPath: string;
  now?: () => number;
  chunkSize?: number;
  files?: FileIO;
}

export interface ScanService {
  /**
   * The current report. Starts a run when there is none, it is stale, or
   * `refresh` is set; `wait: false` returns whatever exists (possibly null)
   * without waiting for that run.
   */
  get(options?: { refresh?: boolean; wait?: boolean }): Promise<ScanReport | null>;
  /** The cached report, stale or not, without starting a run. */
  peek(): Promise<ScanReport | null>;
  status(): Promise<ScanStatus>;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function isReportStale(report: ScanReport | null, nowMs: number): boolean {
  if (!report) return true;
  const generated = Date.parse(report.generatedAt);
  return !Number.isFinite(generated) || scanEpoch(generated) !== scanEpoch(nowMs);
}

export function createScanService(options: ScanServiceOptions): ScanService {
  const now = options.now ?? Date.now;
  const chunkSize = options.chunkSize ?? 15;
  const files = options.files ?? diskIO;
  let report: ScanReport | null = null;
  let loaded = false;
  let running: Promise<ScanReport> | null = null;
  const state: ScanStatus = { running: false, done: 0, total: 0, startedAt: null, finishedAt: null, error: null };

  async function loadReport(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await files.read(options.reportPath)) as ScanReport;
      if (parsed && Array.isArray(parsed.div) && Array.isArray(parsed.stoch)) report = parsed;
    } catch {
      // No report yet.
    }
  }

  async function saveReport(next: ScanReport): Promise<void> {
    try {
      await files.write(options.reportPath, JSON.stringify(next));
    } catch (err) {
      console.warn(`[stocks] could not write scan report: ${describe(err)}`);
    }
  }

  /**
   * Symbols already cached for both timeframes only need a top-up: one
   * multi-symbol request per timeframe covers up to 100 of them. Cold symbols
   * go in small chunks so the first run reports progress as it goes.
   */
  async function planBatches(symbols: string[]): Promise<string[][]> {
    const warm: string[] = [];
    const cold: string[] = [];
    for (const symbol of symbols) {
      const [d, w] = await Promise.all([options.bars.peek(symbol, "1d"), options.bars.peek(symbol, "1w")]);
      (d?.length && w?.length ? warm : cold).push(symbol);
    }
    const batches: string[][] = [];
    for (let i = 0; i < warm.length; i += 100) batches.push(warm.slice(i, i + 100));
    for (let i = 0; i < cold.length; i += chunkSize) batches.push(cold.slice(i, i + chunkSize));
    return batches;
  }

  async function run(): Promise<ScanReport> {
    const startedAt = now();
    Object.assign(state, {
      running: true,
      done: 0,
      total: 0,
      startedAt: new Date(startedAt).toISOString(),
      error: null,
    });
    try {
      const [universe, fns] = await Promise.all([options.loadUniverse(), options.loadScans()]);
      state.total = universe.length;
      const div: DivScanRow[] = [];
      const stoch: StochScanRow[] = [];
      const failures: ScanFailure[] = [];
      let asOf: number | null = null;
      let fetchFailures = 0;

      for (const symbols of await planBatches(universe.map((e) => e.symbol))) {
        const [daily, weekly] = await Promise.all([
          options.bars.ensure(symbols, "1d", DIV_START_MS, "scan"),
          options.bars.ensure(symbols, "1w", STOCH_START_MS, "scan"),
        ]);
        const nowMs = now();
        for (const symbol of symbols) {
          const d = daily.bars.get(symbol);
          if (d && d.length > 0) {
            asOf = Math.max(asOf ?? 0, d[d.length - 1]!.time);
            try {
              div.push(fns.scanDivergence(symbol, d));
            } catch (err) {
              failures.push({ symbol, scan: "div", error: describe(err) });
            }
          } else {
            fetchFailures++;
            failures.push({ symbol, scan: "div", error: daily.failures.get(symbol) ?? "no daily bars" });
          }
          const w = weekly.bars.get(symbol);
          if (w && w.length > 0) {
            try {
              stoch.push(fns.scanStoch(symbol, w, nowMs));
            } catch (err) {
              failures.push({ symbol, scan: "stoch", error: describe(err) });
            }
          } else {
            failures.push({ symbol, scan: "stoch", error: weekly.failures.get(symbol) ?? "no weekly bars" });
          }
          state.done++;
        }
        // Let queued requests (chart, watchlist) run between chunks.
        await tick();
      }

      const order = new Map(universe.map((e, i) => [e.symbol, i]));
      const byUniverse = (a: { symbol: string }, b: { symbol: string }) =>
        (order.get(a.symbol) ?? 0) - (order.get(b.symbol) ?? 0);
      div.sort(byUniverse);
      stoch.sort(byUniverse);
      failures.sort(byUniverse);

      const next: ScanReport = {
        generatedAt: new Date(now()).toISOString(),
        asOf,
        universe,
        div,
        stoch,
        failures,
      };
      // A run that could not fetch most of the universe (network down, plan
      // limits) must not replace a good report.
      if (report && universe.length > 0 && fetchFailures > universe.length / 2) {
        state.error = `Scan aborted: bars unavailable for ${fetchFailures}/${universe.length} symbols (${failures[0]?.error ?? "unknown"})`;
        return report;
      }
      report = next;
      await saveReport(next);
      return next;
    } catch (err) {
      state.error = describe(err);
      throw err;
    } finally {
      state.running = false;
      state.finishedAt = new Date(now()).toISOString();
    }
  }

  return {
    async get({ refresh = false, wait = true } = {}) {
      await loadReport();
      if (!refresh && report && !isReportStale(report, now())) return report;
      running ??= run().finally(() => {
        running = null;
      });
      if (!wait) {
        running.catch(() => {});
        return report;
      }
      try {
        return await running;
      } catch (err) {
        if (report) return report;
        throw err;
      }
    },
    async peek() {
      await loadReport();
      return report;
    },
    async status() {
      await loadReport();
      return {
        ...state,
        reportGeneratedAt: report?.generatedAt ?? null,
        stale: report ? isReportStale(report, now()) : true,
      };
    },
  };
}

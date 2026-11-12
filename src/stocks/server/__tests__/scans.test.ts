import { describe, expect, it, vi } from "vitest";
import type { Bar, DivScanRow, ListEntry, StochScanRow } from "../../types.ts";
import type { BarStore, EnsureResult } from "../barCache.ts";
import type { FileIO } from "../files.ts";
import { DIV_START_MS, STOCH_START_MS, createScanService, isReportStale, type ScanFns } from "../scans.ts";

const universe: ListEntry[] = ["AAA", "BBB", "CCC", "DDD"].map((symbol) => ({ exchange: "NYSE", symbol }));
const bars = (n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => ({ time: 1_700_000_000 + i * 86_400, open: 1, high: 1, low: 1, close: 1, volume: 1 }));

function memoryFiles(): FileIO {
  const data = new Map<string, string>();
  return {
    read: async (p) => {
      const v = data.get(p);
      if (v == null) throw new Error("ENOENT");
      return v;
    },
    write: async (p, t) => {
      data.set(p, t);
    },
  };
}

function fakeStore(missing: Set<string> = new Set()) {
  const ensure = vi.fn(async (symbols: string[], tf: string, startMs: number): Promise<EnsureResult> => {
    const result: EnsureResult = { bars: new Map(), failures: new Map(), requests: 1 };
    for (const s of symbols) {
      if (missing.has(s)) result.failures.set(s, "Alpaca returned no bars");
      else result.bars.set(s, bars(tf === "1d" ? 5 : 3));
    }
    expect(startMs).toBe(tf === "1d" ? DIV_START_MS : STOCH_START_MS);
    return result;
  });
  const store: BarStore = { ensure, peek: vi.fn(async () => null) };
  return { store, ensure };
}

const fns: ScanFns = {
  scanDivergence: (symbol, daily) => {
    if (symbol === "CCC") throw new Error("indicator blew up");
    return { symbol, lastBar: daily[daily.length - 1]!.time } as DivScanRow;
  },
  scanStoch: (symbol, weekly, nowMs) => ({ symbol, lastBar: weekly.length, price: nowMs }) as unknown as StochScanRow,
};

describe("scan service", () => {
  it("scans the universe in list order, recording per-symbol failures", async () => {
    const { store } = fakeStore(new Set(["DDD"]));
    const t = Date.parse("2026-11-12T22:00:00Z");
    const service = createScanService({
      bars: store,
      loadUniverse: async () => universe,
      loadScans: async () => fns,
      reportPath: "/c/scan-report.json",
      now: () => t,
      chunkSize: 2,
      files: memoryFiles(),
    });

    const report = (await service.get())!;
    expect(report.universe).toEqual(universe);
    expect(report.div.map((r) => r.symbol)).toEqual(["AAA", "BBB"]);
    expect(report.stoch.map((r) => r.symbol)).toEqual(["AAA", "BBB", "CCC"]);
    expect(report.failures).toEqual([
      { symbol: "CCC", scan: "div", error: "indicator blew up" },
      { symbol: "DDD", scan: "div", error: "Alpaca returned no bars" },
      { symbol: "DDD", scan: "stoch", error: "Alpaca returned no bars" },
    ]);
    expect(report.asOf).toBe(bars(5)[4]!.time);
    expect(await service.status()).toMatchObject({ running: false, done: 4, total: 4, stale: false });
  });

  it("serves the cached report until the next session settles, or on refresh", async () => {
    const { store, ensure } = fakeStore();
    let t = Date.parse("2026-11-12T22:00:00Z"); // 17:00 ET, after the close
    const service = createScanService({
      bars: store,
      loadUniverse: async () => universe,
      loadScans: async () => fns,
      reportPath: "/c/r.json",
      now: () => t,
      files: memoryFiles(),
    });
    await service.get();
    const runs = () => ensure.mock.calls.length / 2;
    expect(runs()).toBe(1);

    t = Date.parse("2026-11-13T03:00:00Z"); // 22:00 ET, same session
    await service.get();
    expect(runs()).toBe(1);

    t = Date.parse("2026-11-13T15:00:00Z"); // next day
    await service.get();
    expect(runs()).toBe(2);

    await service.get({ refresh: true });
    expect(runs()).toBe(3);
  });

  it("returns immediately with wait: false while the first run is going", async () => {
    const { store } = fakeStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const service = createScanService({
      bars: store,
      loadUniverse: async () => {
        await gate;
        return universe;
      },
      loadScans: async () => fns,
      reportPath: "/c/r.json",
      files: memoryFiles(),
    });
    expect(await service.get({ wait: false })).toBeNull();
    expect((await service.status()).running).toBe(true);
    release();
    const report = await service.get();
    expect(report?.div).toHaveLength(3);
  });

  it("keeps the previous report when most of the universe could not be fetched", async () => {
    const files = memoryFiles();
    let t = Date.parse("2026-11-12T22:00:00Z");
    const good = createScanService({
      bars: fakeStore().store,
      loadUniverse: async () => universe,
      loadScans: async () => fns,
      reportPath: "/c/r.json",
      now: () => t,
      files,
    });
    const first = await good.get();

    t = Date.parse("2026-11-13T22:00:00Z");
    const broken = createScanService({
      bars: fakeStore(new Set(["AAA", "BBB", "CCC"])).store,
      loadUniverse: async () => universe,
      loadScans: async () => fns,
      reportPath: "/c/r.json",
      now: () => t,
      files,
    });
    const report = await broken.get();
    expect(report?.generatedAt).toBe(first?.generatedAt);
    expect((await broken.status()).error).toMatch(/bars unavailable for 3\/4/);
  });

  it("surfaces a scans module that will not load", async () => {
    const service = createScanService({
      bars: fakeStore().store,
      loadUniverse: async () => universe,
      loadScans: async () => Promise.reject(new Error("scans module missing")),
      reportPath: "/c/r.json",
      files: memoryFiles(),
    });
    await expect(service.get()).rejects.toThrow(/scans module missing/);
    expect((await service.status()).error).toMatch(/scans module missing/);
  });

  it("calls a report stale across the 16:20 ET settle and midnight", () => {
    const report = { generatedAt: "2026-11-12T19:00:00Z" } as never; // 14:00 ET
    expect(isReportStale(report, Date.parse("2026-11-12T21:00:00Z"))).toBe(false); // 16:00 ET
    expect(isReportStale(report, Date.parse("2026-11-12T21:30:00Z"))).toBe(true); // 16:30 ET
    expect(isReportStale(null, 0)).toBe(true);
  });
});

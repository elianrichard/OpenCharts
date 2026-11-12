import { describe, expect, it, vi } from "vitest";
import type { Bar } from "../../types.ts";
import type { AlpacaClient, MultiBarsParams } from "../alpaca.ts";
import {
  adjustmentChanged,
  createBarStore,
  decodeCacheFile,
  encodeCacheFile,
  mergeTopUp,
  topUpStartMs,
} from "../barCache.ts";
import type { FileIO } from "../files.ts";

const DAY = 86_400;
const T0 = Date.parse("2026-11-02T05:00:00Z") / 1000;
const bar = (i: number, close: number): Bar => ({
  time: T0 + i * DAY,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 1000 + i,
});

function memoryFiles(): FileIO & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    read: async (path) => {
      const text = data.get(path);
      if (text == null) throw new Error("ENOENT");
      return text;
    },
    write: async (path, text) => {
      data.set(path, text);
    },
  };
}

function fakeClient(respond: (p: MultiBarsParams) => Record<string, Bar[]>) {
  const calls: MultiBarsParams[] = [];
  const client = {
    bars: vi.fn(async (p: MultiBarsParams) => {
      calls.push(p);
      return new Map(Object.entries(respond(p)));
    }),
  } as unknown as AlpacaClient;
  return { client, calls };
}

describe("top-up helpers", () => {
  it("re-grabs from the second-newest cached bar", () => {
    expect(topUpStartMs([])).toBeNull();
    expect(topUpStartMs([bar(0, 1)])).toBe(bar(0, 1).time * 1000);
    expect(topUpStartMs([bar(0, 1), bar(1, 2), bar(2, 3)])).toBe(bar(1, 2).time * 1000);
  });

  it("merges fresh bars over the cache, fresh winning", () => {
    const cached = [bar(0, 1), bar(1, 2), bar(2, 3)];
    const fresh = [bar(1, 2), bar(2, 3.5), bar(3, 4)];
    expect(mergeTopUp(cached, fresh).map((b) => b.close)).toEqual([1, 2, 3.5, 4]);
  });

  it("ignores a change in the newest cached bar (it may have been forming)", () => {
    const cached = [bar(0, 1), bar(1, 2), bar(2, 3)];
    expect(adjustmentChanged(cached, [bar(1, 2), bar(2, 3.4), bar(3, 4)])).toBe(false);
  });

  it("detects re-adjusted history on a settled bar", () => {
    const cached = [bar(0, 100), bar(1, 200), bar(2, 300)];
    // A 2:1 split: Alpaca now serves halved prices for the same days.
    expect(adjustmentChanged(cached, [bar(1, 100), bar(2, 150), bar(3, 151)])).toBe(true);
  });

  it("round-trips the compact file format", () => {
    const series = { symbol: "AAPL", timeframe: "1d" as const, startMs: Date.UTC(2016, 0, 1), bars: [bar(0, 1), bar(1, 2)], updatedAt: 5 };
    expect(decodeCacheFile(encodeCacheFile(series))).toEqual(series);
    expect(decodeCacheFile("not json")).toBeNull();
    expect(decodeCacheFile(JSON.stringify({ v: 2 }))).toBeNull();
  });
});

describe("bar store", () => {
  const start = Date.UTC(2016, 0, 1);
  const now = () => Date.parse("2026-11-12T22:00:00Z");

  it("fetches a missing series whole, then tops it up incrementally", async () => {
    const files = memoryFiles();
    let serve = [bar(0, 1), bar(1, 2), bar(2, 3)];
    const { client, calls } = fakeClient((p) => ({
      AAPL: serve.filter((b) => b.time * 1000 >= p.startMs),
    }));
    const store = createBarStore({ dir: "/cache", client: () => client, now, files });

    const first = await store.ensure(["AAPL"], "1d", start, "scan");
    expect(calls[0]!.startMs).toBe(start);
    expect(calls[0]!.feed).toBe("sip");
    expect(first.bars.get("AAPL")).toHaveLength(3);
    expect([...files.data.keys()]).toEqual(["/cache/bars/1d/AAPL.json"]);

    serve = [bar(0, 1), bar(1, 2), bar(2, 3.2), bar(3, 4)];
    const second = await store.ensure(["AAPL"], "1d", start, "scan");
    expect(calls[1]!.startMs).toBe(bar(1, 2).time * 1000);
    expect(second.bars.get("AAPL")!.map((b) => b.close)).toEqual([1, 2, 3.2, 4]);
    expect(await store.peek("AAPL", "1d")).toHaveLength(4);
  });

  it("refetches the whole series when history was re-adjusted", async () => {
    const files = memoryFiles();
    let serve = [bar(0, 100), bar(1, 200), bar(2, 300)];
    const { client, calls } = fakeClient((p) => ({ AAPL: serve.filter((b) => b.time * 1000 >= p.startMs) }));
    const store = createBarStore({ dir: "/cache", client: () => client, now, files });
    await store.ensure(["AAPL"], "1d", start, "scan");

    serve = [bar(0, 50), bar(1, 100), bar(2, 150), bar(3, 151)];
    const result = await store.ensure(["AAPL"], "1d", start, "scan");
    expect(calls.map((c) => c.startMs)).toEqual([start, bar(1, 0).time * 1000, start]);
    expect(result.bars.get("AAPL")!.map((b) => b.close)).toEqual([50, 100, 150, 151]);
  });

  it("refetches a cache that starts later than requested", async () => {
    const files = memoryFiles();
    const { client, calls } = fakeClient(() => ({ AAPL: [bar(0, 1), bar(1, 2)] }));
    const store = createBarStore({ dir: "/cache", client: () => client, now, files });
    await store.ensure(["AAPL"], "1w", Date.UTC(2021, 0, 1), "scan");
    await store.ensure(["AAPL"], "1w", Date.UTC(2016, 0, 1), "scan");
    expect(calls.map((c) => c.startMs)).toEqual([Date.UTC(2021, 0, 1), Date.UTC(2016, 0, 1)]);
  });

  it("reports failures per symbol instead of throwing", async () => {
    const files = memoryFiles();
    const client = { bars: vi.fn(async () => Promise.reject(new Error("Alpaca 500: boom"))) } as unknown as AlpacaClient;
    const store = createBarStore({ dir: "/cache", client: () => client, now, files });
    const result = await store.ensure(["AAPL", "MSFT"], "1d", start, "scan");
    expect(result.bars.size).toBe(0);
    expect(result.failures.get("MSFT")).toMatch(/boom/);
  });

  it("marks a symbol Alpaca has no bars for", async () => {
    const files = memoryFiles();
    const { client } = fakeClient(() => ({ AAPL: [bar(0, 1)] }));
    const store = createBarStore({ dir: "/cache", client: () => client, now, files });
    const result = await store.ensure(["AAPL", "ZZZZ"], "1d", start, "scan");
    expect(result.bars.has("AAPL")).toBe(true);
    expect(result.failures.get("ZZZZ")).toMatch(/no bars/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, MarketEvent } from "../../../adapter/types.ts";
import type { Bar, StockSnapshot } from "../../types.ts";
import { createAlpacaAdapter } from "../adapter.ts";
import type { StocksClient } from "../client.ts";
import { createSnapshotStore } from "../snapshots.ts";

const at = (iso: string) => Date.parse(iso);

function snap(symbol: string, last: number, over: Partial<StockSnapshot> = {}): StockSnapshot {
  return {
    symbol,
    last,
    lastTime: at("2026-11-10T15:00:00Z"), // Tuesday 10:00 ET
    prevClose: last - 1,
    change: 1,
    changePct: 0.3,
    open: last - 0.5,
    high: last + 0.1,
    low: last - 0.9,
    volume: 1_000_000,
    avgVolume30: 2_000_000,
    bid: last - 0.01,
    ask: last + 0.01,
    extended: null,
    ...over,
  };
}

const bar = (iso: string, close: number): Bar => ({
  time: at(iso) / 1000,
  open: close - 1,
  high: close + 1,
  low: close - 2,
  close,
  volume: 500,
});

function fakeClient(over: Partial<StocksClient> = {}): StocksClient {
  return {
    getBars: vi.fn(async () => []),
    getSnapshots: vi.fn(async () => ({})),
    getAssets: vi.fn(async () => []),
    getList: vi.fn(async () => []),
    getHoldings: vi.fn(),
    getScans: vi.fn(),
    getScanStatus: vi.fn(),
    ...over,
  } as StocksClient;
}

let now = at("2026-11-10T15:00:05Z");

beforeEach(() => {
  vi.useFakeTimers();
  now = at("2026-11-10T15:00:05Z");
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(client: StocksClient) {
  const adapter = createAlpacaAdapter({ client, store: createSnapshotStore(), pollMs: 5_000, now: () => now });
  const events: MarketEvent[] = [];
  const states: ConnectionState[] = [];
  adapter.marketData.subscribe((e) => events.push(e));
  adapter.marketData.onConnectionChange!((s) => states.push(s));
  return { adapter, md: adapter.marketData, events, states };
}

describe("getSymbols", () => {
  it("lists list.txt with company names as Stocks", async () => {
    const client = fakeClient({
      getList: vi.fn(async () => [
        { exchange: "NASDAQ", symbol: "AAPL" },
        { exchange: "NYSE", symbol: "KO" },
      ]),
      getAssets: vi.fn(async () => [{ symbol: "AAPL", name: "Apple Inc. Common Stock", exchange: "NASDAQ", tradable: true }]),
    });
    const symbols = await setup(client).md.getSymbols();
    expect(symbols.map((s) => [s.name, s.displayName, s.category, s.tickSize])).toEqual([
      ["AAPL", "Apple Inc. Common Stock", "Stocks", 0.01],
      ["KO", null, "Stocks", 0.01],
    ]);
    expect(symbols[1]).toMatchObject({ exchange: "NYSE", sessionTimezone: "America/New_York", isActive: true });
    expect((symbols[0] as unknown as { tradingHours: unknown[] }).tradingHours).toHaveLength(5);
  });

  it("still lists symbols when names are unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient({
      getList: vi.fn(async () => [{ exchange: "NYSE", symbol: "KO" }]),
      getAssets: vi.fn(async () => Promise.reject(new Error("503"))),
    });
    expect((await setup(client).md.getSymbols()).map((s) => s.name)).toEqual(["KO"]);
    warn.mockRestore();
  });
});

describe("getCandles", () => {
  it("passes the chart's window through and returns candles oldest first", async () => {
    const getBars = vi.fn(async () => [bar("2026-11-10T05:00:00Z", 1), bar("2026-11-11T05:00:00Z", 2)]);
    const { md } = setup(fakeClient({ getBars }));
    const candles = await md.getCandles({ symbol: "AAPL", timeframe: "1d", fromMs: 1, toMs: 2 });
    expect(getBars).toHaveBeenCalledWith({ symbol: "AAPL", timeframe: "1d", startMs: 1, endMs: 2, limit: undefined });
    expect(candles.map((c) => c.close)).toEqual([1, 2]);
  });

  it("jumps over an empty overnight window to the bars before it", async () => {
    const getBars = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([bar("2026-11-11T20:55:00Z", 5)]);
    const { md } = setup(fakeClient({ getBars }));
    const candles = await md.getCandles({ symbol: "AAPL", timeframe: "1m", fromMs: 1_000, toMs: 2_000 });
    expect(getBars).toHaveBeenLastCalledWith({ symbol: "AAPL", timeframe: "1m", endMs: 2_000, limit: 500 });
    expect(candles).toHaveLength(1);
  });

  it("rejects timeframes Alpaca does not serve", async () => {
    await expect(setup(fakeClient()).md.getCandles({ symbol: "AAPL", timeframe: "2h" })).rejects.toThrow(/Unsupported/);
  });
});

describe("live polling", () => {
  it("fills the store, ticks on the last trade, and only when it changes", async () => {
    let price = 357.1;
    const getSnapshots = vi.fn(async (symbols: string[]) =>
      Object.fromEntries(symbols.map((s) => [s, snap(s, s === "AAPL" ? price : 520)])),
    );
    const { adapter, md, events, states } = setup(fakeClient({ getSnapshots }));
    md.setSymbolInterest!(["aapl", "MSFT"]);
    md.connect!();
    await vi.advanceTimersByTimeAsync(0);

    expect(getSnapshots).toHaveBeenCalledWith(["AAPL", "MSFT"]);
    expect(adapter.snapshots.get("AAPL")?.changePct).toBe(0.3);
    expect(events).toEqual([
      { type: "tick", symbol: "AAPL", bid: 357.1, ask: 357.1, timestamp: at("2026-11-10T15:00:00Z") },
      { type: "tick", symbol: "MSFT", bid: 520, ask: 520, timestamp: at("2026-11-10T15:00:00Z") },
    ]);
    expect(states).toEqual(["disconnected", "connecting", "connected"]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(getSnapshots).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(2);

    price = 357.25;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events.slice(2)).toEqual([
      { type: "tick", symbol: "AAPL", bid: 357.25, ask: 357.25, timestamp: at("2026-11-10T15:00:00Z") },
    ]);
    md.disconnect!();
  });

  it("reports reconnecting while polls fail and recovers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getSnapshots = vi
      .fn()
      .mockRejectedValueOnce(new Error("Stocks API unreachable"))
      .mockResolvedValue({ AAPL: snap("AAPL", 1) });
    const { md, states } = setup(fakeClient({ getSnapshots }));
    md.setSymbolInterest!(["AAPL"]);
    md.connect!();
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states.at(-1)).toBe("connected");
    md.disconnect!();
    expect(states.at(-1)).toBe("disconnected");
    warn.mockRestore();
  });

  it("moves the charted bar with a candle event before the tick", async () => {
    const getBars = vi.fn(async () => [bar("2026-11-09T05:00:00Z", 355), bar("2026-11-10T05:00:00Z", 356.8)]);
    const getSnapshots = vi.fn(async () => ({ AAPL: snap("AAPL", 357.1) }));
    const { md, events } = setup(fakeClient({ getBars, getSnapshots }));
    await md.getCandles({ symbol: "AAPL", timeframe: "1d", limit: 400 });
    md.connect!();
    await vi.advanceTimersByTimeAsync(0);

    expect(events.map((e) => e.type)).toEqual(["candle", "tick"]);
    expect(events[0]).toEqual({
      type: "candle",
      symbol: "AAPL",
      timeframe: "1d",
      open: 355.8,
      high: 357.8,
      low: 354.8,
      close: 357.1,
      volume: 1_000_000,
      timestamp: at("2026-11-10T05:00:00Z") / 1000,
    });

    // Unchanged on the next poll: nothing re-emitted.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events).toHaveLength(2);
    md.disconnect!();
  });

  it("refreshes the charted bar from /bars on its own cadence", async () => {
    const getBars = vi.fn(async () => [bar("2026-11-10T15:00:00Z", 357)]);
    const getSnapshots = vi.fn(async () => ({ AAPL: snap("AAPL", 357.1) }));
    const { md } = setup(fakeClient({ getBars, getSnapshots }));
    await md.getCandles({ symbol: "AAPL", timeframe: "5m", limit: 400 });
    md.connect!();
    await vi.advanceTimersByTimeAsync(0);
    expect(getBars).toHaveBeenCalledTimes(1); // seeded from the history request
    now += 15_000;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getBars).toHaveBeenLastCalledWith({ symbol: "AAPL", timeframe: "5m", limit: 2 });
    md.disconnect!();
  });

  it("dates Thursday ticks so no chart can open a phantom weekly bar", async () => {
    now = at("2026-11-12T15:00:05Z"); // Thursday
    const thursday = { lastTime: at("2026-11-12T15:00:00Z") };
    const getSnapshots = vi.fn(async () => ({ AAPL: snap("AAPL", 357.1, thursday), MSFT: snap("MSFT", 520, thursday) }));
    const { md, events } = setup(fakeClient({ getSnapshots }));
    md.setSymbolInterest!(["AAPL", "MSFT"]);
    md.connect!();
    await vi.advanceTimersByTimeAsync(0);
    const stamps = events.map((e) => (e.type === "tick" ? e.timestamp : null));
    expect(stamps).toEqual([at("2026-11-11T23:59:59.999Z"), at("2026-11-11T23:59:59.999Z")]);
    md.disconnect!();
  });

  it("brings the history's last bar up to the polled trade", async () => {
    const getBars = vi.fn(async () => [bar("2026-11-06T05:00:00Z", 350), bar("2026-11-09T05:00:00Z", 355)]);
    const getSnapshots = vi.fn(async () => ({ AAPL: snap("AAPL", 357.1) }));
    const { md } = setup(fakeClient({ getBars, getSnapshots }));
    await md.getQuote!("AAPL"); // fills the store
    const candles = await md.getCandles({ symbol: "AAPL", timeframe: "1d", limit: 400 });
    // Delayed SIP has no bar for today yet; the snapshot supplies it.
    expect(candles.map((c) => c.time)).toEqual([
      at("2026-11-06T05:00:00Z") / 1000,
      at("2026-11-09T05:00:00Z") / 1000,
      at("2026-11-10T05:00:00Z") / 1000,
    ]);
    expect(candles[2]).toMatchObject({ open: 356.6, close: 357.1, volume: 1_000_000 });
  });

  it("polls right away for newly watched symbols and stops when released", async () => {
    const getSnapshots = vi.fn(async (symbols: string[]) => Object.fromEntries(symbols.map((s) => [s, snap(s, 10)])));
    const { md } = setup(fakeClient({ getSnapshots }));
    md.connect!();
    await vi.advanceTimersByTimeAsync(0);
    expect(getSnapshots).not.toHaveBeenCalled();

    const release = md.watchSymbols(["NVDA"]);
    await vi.advanceTimersByTimeAsync(60);
    expect(getSnapshots).toHaveBeenLastCalledWith(["NVDA"]);

    release();
    getSnapshots.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getSnapshots).not.toHaveBeenCalled();
    md.disconnect!();
  });

  it("primes a quote from the store with bid = ask = last trade", async () => {
    const getSnapshots = vi.fn(async () => ({ AAPL: snap("AAPL", 357.1) }));
    const { md } = setup(fakeClient({ getSnapshots }));
    expect(await md.getQuote!("AAPL")).toEqual({
      symbol: "AAPL",
      bid: 357.1,
      ask: 357.1,
      timestamp: at("2026-11-10T15:00:00Z"),
    });
    expect(await md.getQuote!("AAPL")).not.toBeNull();
    expect(getSnapshots).toHaveBeenCalledTimes(1);
  });
});

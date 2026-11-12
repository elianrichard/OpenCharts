import { describe, expect, it, vi } from "vitest";
import type { Bar } from "../../types.ts";
import {
  AlpacaError,
  appendBarsPage,
  clipSipEnd,
  createAlpacaClient,
  lookbackStartMs,
  mergeBars,
  mergeIexTail,
  SIP_DELAY_MS,
  toAlpacaTimeframe,
  toRfc3339,
  windowBars,
} from "../alpaca.ts";
import { createRateLimiter } from "../rateLimit.ts";

const KEY = "PKTESTKEYID";
const SECRET = "test-secret-value";

const bar = (time: number, close: number, extra: Partial<Bar> = {}): Bar => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 100,
  ...extra,
});

const raw = (iso: string, c: number) => ({ t: iso, o: c, h: c + 1, l: c - 1, c, v: 10 });

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function makeClient(fetchImpl: typeof fetch, now = () => Date.parse("2026-11-12T15:00:00Z")) {
  return createAlpacaClient({
    credentials: { keyId: KEY, secretKey: SECRET },
    dataUrl: "https://data.example",
    tradingUrls: ["https://paper.example", "https://live.example"],
    fetchImpl,
    limiter: createRateLimiter({ now }),
    now,
    sleep: () => Promise.resolve(),
  });
}

describe("timeframe mapping", () => {
  it("maps every terminal timeframe to Alpaca's", () => {
    expect(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"].map(toAlpacaTimeframe)).toEqual([
      "1Min",
      "5Min",
      "15Min",
      "30Min",
      "1Hour",
      "4Hour",
      "1Day",
      "1Week",
    ]);
  });

  it("returns null for anything else", () => {
    expect(toAlpacaTimeframe("2h")).toBeNull();
    expect(toAlpacaTimeframe("")).toBeNull();
  });
});

describe("SIP end clipping", () => {
  const now = Date.parse("2026-11-12T15:00:00Z");

  it("stops 16 minutes ago when no end is given", () => {
    expect(clipSipEnd(undefined, now)).toBe(now - SIP_DELAY_MS);
  });

  it("keeps an older exclusive end, one second inside it", () => {
    const end = Date.parse("2026-11-10T00:00:00Z");
    expect(clipSipEnd(end, now)).toBe(end - 1_000);
  });

  it("clips an end inside the free plan's 15 minutes", () => {
    expect(clipSipEnd(now - 5 * 60_000, now)).toBe(now - SIP_DELAY_MS);
  });

  it("formats RFC 3339 at whole seconds", () => {
    expect(toRfc3339(Date.parse("2026-11-12T14:44:00.999Z"))).toBe("2026-11-12T14:44:00Z");
  });

  it("opens newest-first lookbacks wide enough, never before 2015", () => {
    const end = Date.parse("2026-11-12T00:00:00Z");
    expect(end - lookbackStartMs("1d", end, 5)).toBeGreaterThanOrEqual(5 * 86_400_000);
    expect(lookbackStartMs("1d", end, 100_000)).toBe(Date.UTC(2015, 0, 1));
    expect(end - lookbackStartMs("1m", end, 400)).toBeGreaterThan(2 * 86_400_000);
  });
});

describe("merging", () => {
  it("dedupes by time with the later list winning, oldest first", () => {
    expect(mergeBars([bar(3, 3), bar(1, 1)], [bar(2, 2), bar(3, 30)]).map((b) => [b.time, b.close])).toEqual([
      [1, 1],
      [2, 2],
      [3, 30],
    ]);
  });

  it("joins the IEX tail onto SIP, merging the bar where they meet", () => {
    const sip = [bar(60, 10, { open: 9.5, high: 10.2, low: 9.4, volume: 5000 }), bar(120, 11, { volume: 4000 })];
    const iex = [
      bar(120, 11.5, { high: 11.9, low: 10.8, volume: 30 }),
      bar(180, 12, { volume: 20 }),
    ];
    const out = mergeIexTail(sip, iex);
    expect(out.map((b) => b.time)).toEqual([60, 120, 180]);
    // SIP open/volume, IEX's newer close, the wider range.
    expect(out[1]).toEqual({ time: 120, open: 11, high: 11.9, low: 10.8, close: 11.5, volume: 4000 });
    expect(out[2]!.volume).toBe(20);
  });

  it("handles an empty side", () => {
    expect(mergeIexTail([bar(1, 1)], [])).toEqual([bar(1, 1)]);
    expect(mergeIexTail([], [bar(1, 1)])).toEqual([bar(1, 1)]);
  });

  it("windows to [start, end) and keeps the newest `limit`", () => {
    const bars = [1, 2, 3, 4, 5].map((t) => bar(t, t));
    expect(windowBars(bars, { startMs: 2000, endMs: 5000 }).map((b) => b.time)).toEqual([2, 3, 4]);
    expect(windowBars(bars, { limit: 2 }).map((b) => b.time)).toEqual([4, 5]);
  });

  it("folds multi-symbol pages and drops malformed bars", () => {
    const acc = new Map<string, Bar[]>();
    appendBarsPage(acc, { AAPL: [raw("2026-11-10T05:00:00Z", 1)], MSFT: [raw("2026-11-10T05:00:00Z", 2)] });
    appendBarsPage(acc, { MSFT: [raw("2026-11-11T05:00:00Z", 3), { ...raw("nope", 4) }], X: null });
    appendBarsPage(acc, null);
    expect(acc.get("AAPL")).toHaveLength(1);
    expect(acc.get("MSFT")!.map((b) => b.close)).toEqual([2, 3]);
    expect(acc.get("AAPL")![0]!.time).toBe(Date.parse("2026-11-10T05:00:00Z") / 1000);
  });
});

describe("Alpaca client", () => {
  it("follows next_page_token with SIP, adjustment=all and the key headers", async () => {
    const calls: { url: URL; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, headers: init?.headers as Record<string, string> });
      if (!url.searchParams.get("page_token")) {
        return json({ bars: { AAPL: [raw("2026-11-10T05:00:00Z", 1)] }, next_page_token: "tok" });
      }
      return json({ bars: { AAPL: [raw("2026-11-11T05:00:00Z", 2)], MSFT: [raw("2026-11-11T05:00:00Z", 3)] }, next_page_token: null });
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const map = await client.bars({
      symbols: ["AAPL", "MSFT"],
      timeframe: "1d",
      startMs: Date.UTC(2016, 0, 1),
      endMs: Date.parse("2026-11-12T14:44:00Z"),
      feed: "sip",
      priority: "scan",
    });
    expect(calls).toHaveLength(2);
    const first = calls[0]!.url;
    expect(first.pathname).toBe("/v2/stocks/bars");
    expect(Object.fromEntries(first.searchParams)).toMatchObject({
      symbols: "AAPL,MSFT",
      timeframe: "1Day",
      start: "2016-01-01T00:00:00Z",
      end: "2026-11-12T14:44:00Z",
      adjustment: "all",
      feed: "sip",
      sort: "asc",
      limit: "10000",
    });
    expect(calls[1]!.url.searchParams.get("page_token")).toBe("tok");
    expect(calls[0]!.headers["APCA-API-KEY-ID"]).toBe(KEY);
    expect(map.get("AAPL")!.map((b) => b.close)).toEqual([1, 2]);
    expect(map.get("MSFT")!.map((b) => b.close)).toEqual([3]);
  });

  it("serves intraday charts from SIP up to 16 min ago plus an IEX tail", async () => {
    const now = Date.parse("2026-11-12T15:00:00Z");
    const seen: URLSearchParams[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const p = new URL(String(input)).searchParams;
      seen.push(p);
      if (p.get("feed") === "sip") {
        // newest first, as requested
        return json({
          bars: { AAPL: [raw("2026-11-12T14:40:00Z", 3), raw("2026-11-12T14:35:00Z", 2), raw("2026-11-12T14:30:00Z", 1)] },
          next_page_token: null,
        });
      }
      return json({
        bars: { AAPL: [raw("2026-11-12T14:40:00Z", 3.5), raw("2026-11-12T14:45:00Z", 4), raw("2026-11-12T14:55:00Z", 5)] },
        next_page_token: null,
      });
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch, () => now);
    const bars = await client.chartBars({ symbol: "AAPL", timeframe: "5m", limit: 3 });

    const sip = seen[0]!;
    expect(sip.get("sort")).toBe("desc");
    expect(sip.get("limit")).toBe("3");
    expect(Date.parse(sip.get("end")!)).toBeLessThanOrEqual(now - SIP_DELAY_MS);
    const iex = seen[1]!;
    expect(iex.get("feed")).toBe("iex");
    expect(iex.get("start")).toBe("2026-11-12T14:40:00Z");
    expect(bars.map((b) => b.close)).toEqual([3.5, 4, 5]);
  });

  it("does not fill daily bars from IEX", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ bars: { AAPL: [raw("2026-11-11T05:00:00Z", 2), raw("2026-11-10T05:00:00Z", 1)] }, next_page_token: null }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const bars = await client.chartBars({ symbol: "AAPL", timeframe: "1d", limit: 5 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bars.map((b) => b.close)).toEqual([1, 2]);
  });

  it("keeps the chart's window exclusive at the end", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ bars: { AAPL: [raw("2026-11-10T05:00:00Z", 1), raw("2026-11-11T05:00:00Z", 2)] }, next_page_token: null }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const bars = await client.chartBars({
      symbol: "AAPL",
      timeframe: "1d",
      startMs: Date.parse("2026-11-01T00:00:00Z"),
      endMs: Date.parse("2026-11-11T05:00:00Z"),
    });
    expect(bars.map((b) => b.close)).toEqual([1]);
  });

  it("falls back to SIP alone when IEX fails", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      new URL(String(input)).searchParams.get("feed") === "iex"
        ? json({ message: "forbidden" }, 403)
        : json({ bars: { AAPL: [raw("2026-11-12T14:40:00Z", 3)] }, next_page_token: null }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const bars = await client.chartBars({ symbol: "AAPL", timeframe: "1m", limit: 10 });
    expect(bars.map((b) => b.close)).toEqual([3]);
  });

  it("retries a 429 and then succeeds", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () =>
      ++n === 1 ? json({ message: "too many requests" }, 429) : json({ AAPL: { latestTrade: { t: "2026-11-12T14:00:00Z", p: 1 } } }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const snaps = await client.snapshots(["AAPL"], "iex");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(snaps.AAPL?.latestTrade?.p).toBe(1);
  });

  it("surfaces upstream status and message without the keys", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ message: `subscription does not permit querying recent SIP data (key ${KEY} / ${SECRET})` }, 403),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const err = await client.snapshots(["AAPL"], "sip").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlpacaError);
    expect((err as AlpacaError).status).toBe(403);
    expect((err as AlpacaError).message).toMatch(/does not permit/);
    expect((err as AlpacaError).message).not.toContain(KEY);
    expect((err as AlpacaError).message).not.toContain(SECRET);
  });

  it("tries the paper host first, then the live one, for assets", async () => {
    const hosts: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      hosts.push(url.host);
      return url.host === "paper.example"
        ? json({ message: "unauthorized" }, 401)
        : json([{ symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", tradable: true }]);
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const assets = await client.assets();
    expect(hosts).toEqual(["paper.example", "live.example"]);
    expect(assets[0]!.name).toBe("Apple Inc.");
  });
});

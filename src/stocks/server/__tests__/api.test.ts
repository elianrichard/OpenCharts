import { describe, expect, it, vi } from "vitest";
import type { HoldingsReport, StockSnapshot } from "../../types.ts";
import { createStocksApi, parseTime } from "../api.ts";
import type { StocksConfig } from "../config.ts";
import type { FileIO } from "../files.ts";
import { createRateLimiter } from "../rateLimit.ts";

const KEY = "PKAPITESTKEY";
const SECRET = "api-test-secret";
const NOW = Date.parse("2026-11-12T15:00:00Z");

function config(withKeys = true): StocksConfig {
  return {
    credentials: withKeys ? { keyId: KEY, secretKey: SECRET } : null,
    credentialSource: withKeys ? "env" : null,
    dotenvPath: "/work/trading-script/.env",
    listPath: "/work/trading-script/list.txt",
    journalPath: "/work/trading-script/dashboard/data/journal.json",
    cacheDir: "/work/OpenCharts/.cache/stocks",
    dataUrl: "https://data.example",
    tradingUrls: ["https://paper.example"],
  };
}

const JOURNAL = {
  version: 1,
  fills: [
    { id: "a", side: "buy", ticker: "AAL", qty: 10, price: 12, date: "2026-10-01", createdAt: "2026-10-01T10:00:00Z" },
    { id: "b", side: "buy", ticker: "AAL", qty: 10, price: 14, date: "2026-10-02", createdAt: "2026-10-02T10:00:00Z" },
    { id: "c", side: "sell", ticker: "PDD", qty: 1, price: 100, date: "2026-10-03", createdAt: "2026-10-03T10:00:00Z" },
  ],
  prices: {},
};

function files(extra: Record<string, string> = {}): FileIO {
  const data = new Map<string, string>(
    Object.entries({
      "/work/trading-script/list.txt": "NASDAQ:AAL\nNYSE:KO\n",
      "/work/trading-script/dashboard/data/journal.json": JSON.stringify(JOURNAL),
      ...extra,
    }),
  );
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function api(fetchImpl: typeof fetch = vi.fn() as unknown as typeof fetch, opts: { keys?: boolean; io?: FileIO } = {}) {
  return createStocksApi({
    loadConfig: async () => config(opts.keys ?? true),
    loadScans: async () => Promise.reject(new Error("not in this test")),
    fetchImpl,
    now: () => NOW,
    limiter: createRateLimiter({ now: () => NOW }),
    files: opts.io ?? files(),
  });
}

const q = (s: string) => new URLSearchParams(s);

describe("/stocks-api routes", () => {
  it("serves list.txt", async () => {
    const res = await api().handle("/list", q(""));
    expect(res).toEqual({
      status: 200,
      body: [
        { exchange: "NASDAQ", symbol: "AAL" },
        { exchange: "NYSE", symbol: "KO" },
      ],
    });
  });

  it("serves holdings from journal.json with engine warnings", async () => {
    const res = await api().handle("/holdings", q(""));
    const body = res.body as HoldingsReport;
    expect(res.status).toBe(200);
    expect(body.open).toEqual([
      { symbol: "AAL", shares: 20, avgPrice: 13, cost: 260, since: "2026-10-01", buys: 2, partial: false },
    ]);
    expect(body.warnings).toEqual(["2026-10-03 sell PDD 1 @ 100: No open PDD position to sell"]);
  });

  it("404s a missing journal and 422s a broken one", async () => {
    const io = files();
    const missing = createStocksApi({
      loadConfig: async () => ({ ...config(), journalPath: "/nope.json" }),
      loadScans: async () => Promise.reject(new Error("x")),
      files: io,
    });
    expect((await missing.handle("/holdings", q(""))).status).toBe(404);
    const broken = api(undefined, { io: files({ "/work/trading-script/dashboard/data/journal.json": "{oops" }) });
    expect((await broken.handle("/holdings", q(""))).status).toBe(422);
  });

  it("validates /bars parameters", async () => {
    const a = api();
    expect((await a.handle("/bars", q("timeframe=1d"))).status).toBe(400);
    expect((await a.handle("/bars", q("symbol=AAPL&timeframe=2h"))).status).toBe(400);
    expect((await a.handle("/bars", q("symbol=AAPL&timeframe=1d&limit=0"))).status).toBe(400);
    expect((await a.handle("/bars", q("symbol=AAPL&timeframe=1d&start=yesterday"))).status).toBe(400);
    expect(await a.handle("/bars", q("symbol=AAPL&timeframe=1d&start=2000&end=1000"))).toEqual({ status: 200, body: [] });
  });

  it("answers 503 with a clear message, and no keys, when keys are missing", async () => {
    const res = await api(undefined, { keys: false }).handle("/bars", q("symbol=AAPL&timeframe=1d"));
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toMatch(/ALPACA_API_KEY/);
    // Endpoints that need no Alpaca keep working.
    expect((await api(undefined, { keys: false }).handle("/list", q(""))).status).toBe(200);
  });

  it("re-reads only the tail of a repeated newest-N request", async () => {
    let t = NOW;
    const seen: URLSearchParams[] = [];
    const day = (d: string, c: number) => ({ t: `${d}T05:00:00Z`, o: c, h: c, l: c, c, v: 1 });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const p = new URL(String(input)).searchParams;
      seen.push(p);
      return p.get("sort") === "desc"
        ? json({ bars: { AAPL: [day("2026-11-11", 3), day("2026-11-10", 2), day("2026-11-09", 1)] }, next_page_token: null })
        : json({ bars: { AAPL: [day("2026-11-10", 2), day("2026-11-11", 3.5), day("2026-11-12", 4)] }, next_page_token: null });
    });
    const a = createStocksApi({
      loadConfig: async () => config(),
      loadScans: async () => Promise.reject(new Error("x")),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => t,
      limiter: createRateLimiter({ now: () => t }),
      files: files(),
    });
    const first = await a.handle("/bars", q("symbol=AAPL&timeframe=1d&limit=3"));
    expect((first.body as { close: number }[]).map((b) => b.close)).toEqual([1, 2, 3]);

    t += 60_000; // past the short response cache
    const second = await a.handle("/bars", q("symbol=AAPL&timeframe=1d&limit=3"));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.get("sort")).toBe("asc");
    expect(seen[1]!.get("start")).toBe("2026-11-10T05:00:00Z");
    expect((second.body as { close: number }[]).map((b) => b.close)).toEqual([2, 3.5, 4]);
  });

  it("passes upstream errors through with their status", async () => {
    const fetchImpl = vi.fn(async () => json({ message: "forbidden." }, 403)) as unknown as typeof fetch;
    const res = await api(fetchImpl).handle("/bars", q("symbol=AAPL&timeframe=1d&limit=5"));
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it("builds snapshots from the IEX and delayed SIP feeds in one batch each", async () => {
    const feeds: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v2/stocks/snapshots") {
        feeds.push(`${url.searchParams.get("feed")}:${url.searchParams.get("symbols")}`);
        return url.searchParams.get("feed") === "iex"
          ? json({ AAPL: { latestTrade: { t: "2026-11-12T14:59:58Z", p: 357.1 } }, MSFT: { latestTrade: { t: "2026-11-12T14:59:50Z", p: 520 } } })
          : json({
              AAPL: {
                dailyBar: { t: "2026-11-12T05:00:00Z", o: 356, h: 357, l: 355, c: 356.8, v: 5_000_000 },
                prevDailyBar: { t: "2026-11-11T05:00:00Z", o: 350, h: 356, l: 349, c: 355.63, v: 34_000_000 },
              },
            });
      }
      // avgVolume30 backfill for symbols with no cached daily bars
      return json({ bars: {}, next_page_token: null });
    });
    const res = await api(fetchImpl as unknown as typeof fetch).handle("/snapshots", q("symbols=aapl,MSFT,AAPL"));
    expect(res.status).toBe(200);
    expect(feeds.sort()).toEqual(["delayed_sip:AAPL,MSFT", "iex:AAPL,MSFT"]);
    const body = res.body as Record<string, StockSnapshot>;
    expect(body.AAPL).toMatchObject({ last: 357.1, prevClose: 355.63, volume: 5_000_000 });
    expect(body.MSFT).toMatchObject({ last: 520, prevClose: null });
  });

  it("names assets from Alpaca, falling back to list.txt when it is unavailable", async () => {
    const ok = vi.fn(async () =>
      json([
        { symbol: "AAL", name: "American Airlines Group Inc.", exchange: "NASDAQ", tradable: true },
        { symbol: "KO", name: "Coca-Cola Company (The)", exchange: "NYSE", tradable: true },
      ]),
    ) as unknown as typeof fetch;
    expect((await api(ok).handle("/assets", q(""))).body).toEqual([
      { symbol: "AAL", name: "American Airlines Group Inc.", exchange: "NASDAQ", tradable: true },
      { symbol: "KO", name: "Coca-Cola Company (The)", exchange: "NYSE", tradable: true },
    ]);

    const down = vi.fn(async () => json({ message: "unauthorized" }, 401)) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await api(down).handle("/assets", q("symbols=KO,ZZZ"))).body).toEqual([
      { symbol: "KO", name: "KO", exchange: "NYSE", tradable: true },
      { symbol: "ZZZ", name: "ZZZ", exchange: "", tradable: true },
    ]);
    warn.mockRestore();
  });

  it("404s unknown routes and reports scan status before any run", async () => {
    const a = api();
    expect((await a.handle("/nope", q(""))).status).toBe(404);
    expect(await a.handle("/scans/status", q(""))).toEqual({
      status: 200,
      body: {
        running: false,
        done: 0,
        total: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
        reportGeneratedAt: null,
        stale: true,
      },
    });
  });
});

describe("parseTime", () => {
  it("accepts epoch ms, epoch seconds and ISO dates", () => {
    expect(parseTime("1794373200000", "start")).toBe(1794373200000);
    expect(parseTime("1794373200", "start")).toBe(1794373200000);
    expect(parseTime("2026-11-11T05:00:00Z", "start")).toBe(1794373200000);
    expect(parseTime(null, "start")).toBeUndefined();
  });
});

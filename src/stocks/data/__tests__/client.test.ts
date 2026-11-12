import { describe, expect, it, vi } from "vitest";
import { barsSearch, createStocksClient, StocksApiError } from "../client.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(respond: (url: string) => Response) {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return respond(String(input));
  });
  return { client: createStocksClient({ fetchImpl: fetchImpl as unknown as typeof fetch }), urls, fetchImpl };
}

describe("stocks client", () => {
  it("builds /bars queries in epoch ms", () => {
    expect(barsSearch({ symbol: "AAPL", timeframe: "5m", startMs: 1000.7, endMs: 2000, limit: 300 }).toString()).toBe(
      "symbol=AAPL&timeframe=5m&start=1000&end=2000&limit=300",
    );
    expect(barsSearch({ symbol: "AAPL", timeframe: "1d" }).toString()).toBe("symbol=AAPL&timeframe=1d");
  });

  it("hits each endpoint under /stocks-api", async () => {
    const { client, urls } = setup((url) => json(url.includes("/scans/status") ? { running: false } : []));
    await client.getBars({ symbol: "AAPL", timeframe: "1d", limit: 5 });
    await client.getSnapshots(["aapl", "MSFT", "AAPL"]);
    await client.getAssets();
    await client.getAssets(["KO"]);
    await client.getList();
    await client.getHoldings();
    await client.getScanStatus();
    await client.getScans({ refresh: true });
    expect(urls).toEqual([
      "/stocks-api/bars?symbol=AAPL&timeframe=1d&limit=5",
      "/stocks-api/snapshots?symbols=AAPL%2CMSFT",
      "/stocks-api/assets",
      "/stocks-api/assets?symbols=KO",
      "/stocks-api/list",
      "/stocks-api/holdings",
      "/stocks-api/scans/status",
      "/stocks-api/scans?refresh=1",
    ]);
  });

  it("skips the request for an empty snapshot list", async () => {
    const { client, fetchImpl } = setup(() => json({}));
    expect(await client.getSnapshots([])).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null while the first scan is still running", async () => {
    const { client, urls } = setup(() => json({ running: true, done: 3, total: 150, startedAt: "x" }, 202));
    expect(await client.getScans({ wait: false })).toBeNull();
    expect(urls[0]).toBe("/stocks-api/scans?wait=0");
  });

  it("throws the server's error message with its status", async () => {
    const { client } = setup(() => json({ error: "Alpaca API keys are not configured." }, 503));
    const err = await client.getBars({ symbol: "AAPL", timeframe: "1d" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StocksApiError);
    expect(err).toMatchObject({ status: 503, message: "Alpaca API keys are not configured." });
  });

  it("explains a missing plugin instead of failing on HTML", async () => {
    const { client } = setup(() => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(client.getList()).rejects.toThrow(/alpacaProxy plugin/);
  });

  it("wraps network failures", async () => {
    const client = createStocksClient({
      fetchImpl: vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch,
    });
    await expect(client.getList()).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/unreachable/) });
  });
});

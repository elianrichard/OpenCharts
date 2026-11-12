import { describe, expect, it, vi } from "vitest";
import { missingKeysMessage, parseDotenv, resolveConfig } from "../config.ts";
import { parseList } from "../list.ts";
import { createRateLimiter } from "../rateLimit.ts";

describe("parseDotenv", () => {
  it("reads plain, exported, quoted and commented values", () => {
    expect(
      parseDotenv(
        [
          "# comment",
          "ALPACA_API_KEY=abc123",
          "export ALPACA_SECRET_KEY = 'se cret'",
          'MULTI="a\\nb"',
          "INLINE=value # trailing comment",
          "HASH=a#b",
          "EMPTY=",
          "not a line",
        ].join("\n"),
      ),
    ).toEqual({
      ALPACA_API_KEY: "abc123",
      ALPACA_SECRET_KEY: "se cret",
      MULTI: "a\nb",
      INLINE: "value",
      HASH: "a#b",
      EMPTY: "",
    });
  });
});

describe("resolveConfig", () => {
  const root = "/work/OpenCharts";

  it("prefers keys from the environment and resolves paths from the root", async () => {
    const readText = vi.fn(async () => null);
    const config = await resolveConfig({ ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s" }, root, readText);
    expect(config.credentials).toEqual({ keyId: "k", secretKey: "s" });
    expect(config.credentialSource).toBe("env");
    expect(readText).not.toHaveBeenCalled();
    expect(config.listPath).toBe("/work/trading-script/list.txt");
    expect(config.journalPath).toBe("/work/trading-script/dashboard/data/journal.json");
    expect(config.cacheDir).toBe("/work/OpenCharts/.cache/stocks");
    expect(config.tradingUrls).toEqual(["https://paper-api.alpaca.markets", "https://api.alpaca.markets"]);
  });

  it("falls back to the trading-script dotenv when keys are absent", async () => {
    const readText = vi.fn(async (path: string) =>
      path === "/work/trading-script/.env" ? "ALPACA_API_KEY=k2\nALPACA_SECRET_KEY=s2\n" : null,
    );
    const config = await resolveConfig({}, root, readText);
    expect(config.credentials).toEqual({ keyId: "k2", secretKey: "s2" });
    expect(config.credentialSource).toBe("/work/trading-script/.env");
  });

  it("honours STOCKS_* overrides and the APCA_* key names", async () => {
    const readText = vi.fn(async () => "APCA_API_KEY_ID=k3\nAPCA_API_SECRET_KEY=s3");
    const config = await resolveConfig(
      {
        STOCKS_DOTENV: "secrets/alpaca.env",
        STOCKS_LIST_PATH: "/data/list.txt",
        STOCKS_JOURNAL_PATH: "j.json",
        STOCKS_CACHE_DIR: "/tmp/c",
      },
      root,
      readText,
    );
    expect(readText).toHaveBeenCalledWith("/work/OpenCharts/secrets/alpaca.env");
    expect(config.credentials).toEqual({ keyId: "k3", secretKey: "s3" });
    expect(config).toMatchObject({ listPath: "/data/list.txt", journalPath: "/work/OpenCharts/j.json", cacheDir: "/tmp/c" });
  });

  it("explains missing keys without values", async () => {
    const config = await resolveConfig({ ALPACA_API_KEY: "only-half" }, root, async () => null);
    expect(config.credentials).toBeNull();
    const message = missingKeysMessage(config);
    expect(message).toMatch(/ALPACA_API_KEY and ALPACA_SECRET_KEY/);
    expect(message).toContain("/work/trading-script/.env");
    expect(message).not.toContain("only-half");
  });
});

describe("parseList", () => {
  it("reads EXCHANGE:SYMBOL lines like list.txt", () => {
    expect(parseList("NASDAQ:AAL\nNYSE:BRK-B\n\n# note\n  nyse:ko  \nAAPL\nNASDAQ:AAL\nbad line!\n")).toEqual([
      { exchange: "NASDAQ", symbol: "AAL" },
      { exchange: "NYSE", symbol: "BRK.B" },
      { exchange: "NYSE", symbol: "KO" },
      { exchange: "", symbol: "AAPL" },
    ]);
  });
});

describe("rate limiter", () => {
  it("holds scans at their cap while interactive calls still pass", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const limiter = createRateLimiter({
      windowMs: 60_000,
      caps: { live: 3, scan: 2 },
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    await limiter.acquire("scan");
    await limiter.acquire("scan");
    // A third scan request would wait for the window; a live one goes now.
    await limiter.acquire("live");
    expect(sleeps).toEqual([]);
    expect(limiter.inWindow()).toBe(3);
    await limiter.acquire("scan");
    expect(sleeps.length).toBeGreaterThan(0);
    expect(t).toBeGreaterThanOrEqual(60_000);
  });
});

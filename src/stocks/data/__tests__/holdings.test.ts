import { describe, expect, it } from "vitest";
import { buildBook, holdingPnl, holdingsFromJournal } from "../holdings.ts";
import { parseJournal, parseLine, parseText, type JournalFill } from "../journal.ts";

/** Shaped like trading-script/dashboard/data/journal.json (values invented). */
const JOURNAL = {
  version: 1,
  fills: [
    {
      id: "m1",
      side: "buy",
      ticker: "AVGO",
      qty: 10,
      price: 300,
      date: "2026-10-01",
      source: "buy AVGO 10 @ 300",
      createdAt: "2026-10-01T14:00:00.000Z",
    },
    {
      id: "m2",
      side: "buy",
      ticker: "AVGO",
      qty: 10,
      price: 320,
      date: "2026-10-02",
      source: "buy AVGO 10 @ 320",
      createdAt: "2026-10-02T14:00:00.000Z",
    },
    {
      id: "m3",
      side: "sell",
      ticker: "AVGO",
      qty: 5,
      price: 350,
      date: "2026-10-10",
      source: "sell AVGO 5 @ 350",
      createdAt: "2026-10-10T14:00:00.000Z",
    },
    { id: "m4", side: "buy", ticker: "X", qty: 10, price: 100, date: "2026-10-01", createdAt: "2026-10-01T15:00:00.000Z" },
    { id: "m5", side: "sell", ticker: "X", qty: 4, price: 110, date: "2026-10-03", createdAt: "2026-10-03T15:00:00.000Z" },
    { id: "m6", side: "sell", ticker: "X", qty: null, price: 120, date: "2026-10-05", createdAt: "2026-10-05T15:00:00.000Z" },
    { id: "m7", side: "buy", ticker: "CG", qty: null, price: 36.72, date: "2026-10-14", createdAt: "2026-10-14T15:00:00.000Z" },
    { id: "m8", side: "sell", ticker: "PDD", qty: 1, price: 100, date: "2026-10-15", createdAt: "2026-10-15T15:00:00.000Z" },
  ],
  prices: { cg: { price: 40.36, date: "2026-10-20" } },
};

let n = 0;
const fill = (
  side: "buy" | "sell",
  ticker: string,
  qty: number | null,
  price: number | null,
  date: string,
): JournalFill => ({
  id: `f${++n}`,
  side,
  ticker,
  qty,
  price,
  date,
  createdAt: `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`,
});

describe("holdingsFromJournal (journal.json -> HoldingsReport)", () => {
  const report = holdingsFromJournal(JOURNAL);

  it("keeps open positions at average cost after partial sells", () => {
    expect(report.open).toEqual([
      { symbol: "AVGO", shares: 15, avgPrice: 310, cost: 4650, since: "2026-10-01", buys: 2, partial: false },
      { symbol: "CG", shares: 0, avgPrice: 36.72, cost: 0, since: "2026-10-14", buys: 1, partial: true },
    ]);
  });

  it("realizes P/L on the sell that closes a position", () => {
    expect(report.closed).toHaveLength(1);
    const x = report.closed[0]!;
    expect(x).toMatchObject({ symbol: "X", openedOn: "2026-10-01", closedOn: "2026-10-05", shares: 10, avgEntry: 100 });
    expect(x.avgExit).toBeCloseTo(116);
    expect(x.realized).toBeCloseTo(4 * 10 + 6 * 20);
    expect(x.realizedPct).toBeCloseTo(16);
  });

  it("turns unusable fills into warnings", () => {
    expect(report.warnings).toEqual(["2026-10-15 sell PDD 1 @ 100: No open PDD position to sell"]);
  });

  it("matches the dashboard's open P/L, odd-ratio rule included", () => {
    const avgo = report.open[0]!;
    expect(holdingPnl(avgo, 341).usd).toBeCloseTo(15 * 31);
    expect(holdingPnl(avgo, 341).pct).toBeCloseTo(10);
    const cg = report.open[1]!;
    expect(holdingPnl(cg, 40.36)).toMatchObject({ usd: null, odd: false });
    expect(holdingPnl(cg, 40.36).pct).toBeCloseTo(9.913, 2);
    expect(holdingPnl(cg, 200).odd).toBe(true);
    expect(holdingPnl(cg, null)).toEqual({ pct: null, usd: null, partial: false, odd: false });
  });
});

describe("buildBook (dashboard positions.ts semantics)", () => {
  it("flags sells with no position or too many shares", () => {
    const a = fill("sell", "PDD", 1, 100, "2026-10-01");
    const b = fill("buy", "MSFT", 5, 400, "2026-10-01");
    const c = fill("sell", "MSFT", 6, 410, "2026-10-02");
    const book = buildBook([a, b, c]);
    expect(book.issues.map((i) => [i.fill.id, i.reason])).toEqual([
      [a.id, "No open PDD position to sell"],
      [c.id, "Sells 6, but only 5 MSFT were held"],
    ]);
    expect(book.open[0]!.shares).toBe(5);
  });

  it("replays a same-day draft after saved fills", () => {
    const buy = fill("buy", "PDD", 3, 120, "2026-11-10");
    const draft: JournalFill = { ...fill("sell", "PDD", null, 85, "2026-11-10"), createdAt: "~0000" };
    const book = buildBook([draft, buy]);
    expect(book.issues).toHaveLength(0);
    expect(book.closed[0]!.realized).toBeCloseTo(-105);
  });

  it("reopens a ticker after it closes", () => {
    const book = buildBook([
      fill("buy", "AAL", 10, 12, "2026-09-01"),
      fill("sell", "AAL", null, 13, "2026-09-20"),
      fill("buy", "AAL", 5, 12.5, "2026-10-19"),
    ]);
    expect(book.closed).toHaveLength(1);
    expect(book.open[0]).toMatchObject({ shares: 5, since: "2026-10-19" });
  });

  it("realizes only the priced share when some buys had no price", () => {
    const book = buildBook([
      fill("buy", "AMD", 10, 100, "2026-10-01"),
      fill("buy", "AMD", 10, null, "2026-10-02"),
      fill("sell", "AMD", 20, 120, "2026-10-03"),
    ]);
    const t = book.closed[0]!;
    expect(t.realized).toBeCloseTo(10 * 20);
    expect(t.realizedPct).toBeCloseTo(20);
    expect(t.shares).toBe(20);
  });

  it("reports the stated shares when a buy had no quantity", () => {
    const book = buildBook([
      fill("buy", "KO", 5, 60, "2026-10-01"),
      fill("buy", "KO", null, 62, "2026-10-02"),
      fill("sell", "KO", null, 65, "2026-10-03"),
    ]);
    expect(book.closed[0]).toMatchObject({ shares: 5, realized: null });
    // avg entry comes from the priced buy alone, as in the dashboard
    expect(book.closed[0]!.realizedPct).toBeCloseTo((65 / 60 - 1) * 100);
  });
});

describe("parseJournal", () => {
  it("rejects a file that is not a journal", () => {
    expect(parseJournal([]).warnings[0]).toMatch(/expected an object/);
    expect(parseJournal(null).fills).toEqual([]);
  });

  it("normalizes tickers and reads manual prices", () => {
    const j = parseJournal(JOURNAL);
    expect(j.fills).toHaveLength(8);
    expect(j.prices).toEqual({ CG: { price: 40.36, date: "2026-10-20" } });
    expect(parseJournal({ version: 1, fills: [{ side: "buy", ticker: "nyse:brk-b", date: "2026-10-01" }] }).fills[0]).toMatchObject({
      ticker: "BRK.B",
      qty: null,
      price: null,
      id: "fill-1",
    });
  });

  it("falls back to the typed line when structured fields are missing", () => {
    const j = parseJournal({ version: 1, fills: [{ id: "s", source: "bought AVGO 10 @ 334.19", date: "2026-10-01" }] });
    expect(j.fills[0]).toMatchObject({ side: "buy", ticker: "AVGO", qty: 10, price: 334.19 });
  });

  it("warns about fills it cannot use, by their line", () => {
    const j = parseJournal({
      version: 1,
      fills: [
        { id: "a", side: "buy", ticker: "AVGO", date: "Oct 1" },
        { id: "b", side: "hold", ticker: "AVGO", date: "2026-10-01" },
        { id: "c", side: "buy", ticker: "AVGO", qty: -1, date: "2026-10-01" },
        { id: "d", source: "buy AVGO PDD", date: "2026-10-01" },
        { id: "e", source: "byu AVGO", date: "2026-10-01" },
        "nonsense",
      ],
    });
    expect(j.fills).toEqual([]);
    expect(j.warnings).toEqual([
      "Oct 1 buy AVGO (fill #1): missing or invalid date",
      '2026-10-01 hold AVGO (fill #2): side must be "buy" or "sell"',
      "2026-10-01 buy AVGO (fill #3): quantity must be above 0",
      '2026-10-01 "buy AVGO PDD": names several tickers; record them as separate fills',
      '2026-10-01 "byu AVGO": Start with buy or sell',
      "Fill #6: not an object",
    ]);
  });
});

describe("parseLine (port of the dashboard parser)", () => {
  const ok = (line: string) => {
    const r = parseLine(line);
    if (!r.ok) throw new Error(`${line}: ${r.reason}`);
    return r.fills;
  };

  it.each([
    ["buy AVGO", { ticker: "AVGO", qty: null, price: null }],
    ["bought AVGO 10 @ 334.19", { ticker: "AVGO", qty: 10, price: 334.19 }],
    ["buy 10 AVGO @ 334.19", { ticker: "AVGO", qty: 10, price: 334.19 }],
    ["/buy NASDAQ:AVGO 1,000 sh @ 334,19", { ticker: "AVGO", qty: 1000, price: 334.19 }],
    ["beli $brk-b 2", { ticker: "BRK.B", qty: 2, price: null }],
  ])("%s", (line, want) => {
    expect(ok(line)).toEqual([{ side: "buy", ...want }]);
  });

  it("reads sells and several tickers, skips /start", () => {
    expect(ok("sold AVGO @ 350")).toEqual([{ side: "sell", ticker: "AVGO", qty: null, price: 350 }]);
    expect(ok("buy AVGO PDD MSFT").map((f) => f.ticker)).toEqual(["AVGO", "PDD", "MSFT"]);
    expect(parseText("\n/start\nbuy AVGO\n\n")).toHaveLength(1);
    expect(parseLine("buy AVGO 10 @").ok).toBe(false);
  });
});

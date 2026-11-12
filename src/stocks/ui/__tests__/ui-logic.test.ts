import { describe, expect, it } from "vitest";
import type { DivScanRow, HoldingsReport, ScanReport, StochScanRow } from "../../types.ts";
import { crossed } from "../alerts/alertEngine.ts";
import { layoutPanes } from "../chart/paneLayout.ts";
import { fmtPct, fmtPrice, fmtSigned, fmtVolume } from "../format.ts";
import { presetRange, RANGE_PRESETS, usSession } from "../range.ts";
import { buildSections, divTag, stochTag } from "../watchlist/model.ts";

const div = (p: Partial<DivScanRow> & { symbol: string }): DivScanRow => ({
  lastBar: 0,
  price: 10,
  divNow: 0,
  divSum: 0,
  ibs: 0.5,
  state: null,
  signalDate: null,
  entryDate: null,
  entry: null,
  held: null,
  left: null,
  pnlPct: null,
  ...p,
});

const stoch = (p: Partial<StochScanRow> & { symbol: string }): StochScanRow => ({
  interval: "1w",
  lastBar: 0,
  price: 10,
  stage: null,
  signalDate: null,
  daysSince: null,
  entry: null,
  sl: null,
  tp: null,
  fresh: false,
  crosses: null,
  gaps: null,
  nEvents: 0,
  ...p,
});

describe("layoutPanes", () => {
  it("gives every pane a disjoint band under the main chart", () => {
    const l = layoutPanes(["stochrsi", "rsi", "macd"], true);
    expect(l.panes).toHaveLength(3);
    for (let i = 1; i < l.panes.length; i++) {
      expect(l.panes[i]!.start).toBeCloseTo(l.panes[i - 1]!.end, 10);
    }
    expect(l.panes[l.panes.length - 1]!.end).toBeCloseTo(1, 10);
    // The main band ends above the first pane.
    expect(1 - l.main.bottom).toBeLessThanOrEqual(l.panes[0]!.start);
    // Volume sits right on top of the panes.
    expect(l.volume.bottom).toBeCloseTo(l.total, 10);
  });

  it("leaves the whole chart to price when there are no panes", () => {
    const l = layoutPanes([], false);
    expect(l.total).toBe(0);
    expect(l.main.bottom).toBeCloseTo(0.04, 10);
  });
});

describe("usSession", () => {
  it("reads New York time across DST", () => {
    // 2026-11-12 14:00 UTC = 09:00 EST (pre-market)
    expect(usSession(new Date(Date.UTC(2026, 10, 12, 14, 0))).session).toBe("Pre-market");
    // 2026-07-15 14:00 UTC = 10:00 EDT (open)
    expect(usSession(new Date(Date.UTC(2026, 6, 15, 14, 0))).session).toBe("Market open");
    // 2026-11-12 22:00 UTC = 17:00 EST (after hours)
    expect(usSession(new Date(Date.UTC(2026, 10, 12, 22, 0))).session).toBe("After hours");
    // Saturday
    expect(usSession(new Date(Date.UTC(2026, 10, 14, 15, 0))).session).toBe("Market closed");
  });

  it("formats the clock as HH:MM:SS ET", () => {
    expect(usSession(new Date(Date.UTC(2026, 10, 12, 14, 5, 9))).clock).toBe("09:05:09 ET");
  });
});

describe("presetRange", () => {
  const last = Date.UTC(2026, 10, 11, 5) / 1000;
  it("YTD starts on Jan 1", () => {
    const ytd = RANGE_PRESETS.find((p) => p.id === "YTD")!;
    expect(presetRange(ytd, last)).toEqual({ from: Date.UTC(2026, 0, 1) / 1000, to: last });
  });
  it("All fits the content", () => {
    expect(presetRange(RANGE_PRESETS.find((p) => p.id === "All")!, last)).toBeNull();
  });
});

describe("crossed", () => {
  it("fires on the side it watches", () => {
    expect(crossed("above", 100, 99, 100)).toBe(true);
    expect(crossed("above", 100, 101, 99)).toBe(false);
    expect(crossed("below", 100, 101, 99.5)).toBe(true);
    expect(crossed("crossing", 100, 101, 99)).toBe(true);
    expect(crossed("crossing", 100, 101, 102)).toBe(false);
  });
});

describe("watchlist sections", () => {
  const report: ScanReport = {
    generatedAt: "2026-11-12T00:00:00Z",
    asOf: 0,
    universe: [
      { exchange: "NASDAQ", symbol: "AAL" },
      { exchange: "NYSE", symbol: "DAL" },
      { exchange: "NASDAQ", symbol: "KRYS" },
    ],
    div: [
      div({ symbol: "AAL", state: "HOLD", left: 4, held: 17 }),
      div({ symbol: "DAL", state: "NEW", divSum: 5 }),
      div({ symbol: "KRYS", state: "EXIT", left: 1 }),
    ],
    stoch: [
      stoch({ symbol: "DAL", stage: "ARMED", fresh: true, daysSince: 3 }),
      stoch({ symbol: "AAL", stage: "CONFIRMED", fresh: false }),
    ],
    failures: [],
  };
  const holdings: HoldingsReport = {
    open: [{ symbol: "AAL", shares: 10, avgPrice: 12, cost: 120, since: "2026-10-20", buys: 1, partial: false }],
    closed: [],
    warnings: [],
  };

  it("orders Divergence Buy as buy, sell, then holding by sessions left", () => {
    const s = buildSections({ report, holdings, universe: report.universe, watchlist: ["UBER"] });
    const divSection = s.find((x) => x.id === "divbuy")!;
    expect(divSection.rows.map((r) => r.symbol)).toEqual(["DAL", "KRYS", "AAL"]);
    expect(divSection.rows.find((r) => r.symbol === "AAL")!.held).toBe(true);
  });

  it("lists only fresh weekly setups", () => {
    const s = buildSections({ report, holdings, universe: report.universe, watchlist: [] });
    expect(s.find((x) => x.id === "stoch")!.rows.map((r) => r.symbol)).toEqual(["DAL"]);
  });

  it("tags rows with the Divergence Buy state first", () => {
    expect(divTag(report.div[0])?.text).toBe("4 left");
    expect(divTag(report.div[1])?.text).toBe("Buy");
    expect(divTag(report.div[2])?.text).toBe("Sell");
    expect(stochTag(report.stoch[0])?.text).toBe("ARM");
    expect(stochTag(report.stoch[1])).toBeUndefined();
  });
});

describe("format", () => {
  it("carries the sign in the text and dashes missing values", () => {
    expect(fmtSigned(2.314)).toBe("+2.31");
    expect(fmtSigned(-0.95)).toBe("−0.95");
    expect(fmtSigned(0)).toBe("0.00");
    expect(fmtPct(null)).toBe("–");
    expect(fmtPrice(0.12345)).toBe("0.1235");
    expect(fmtPrice(5475)).toBe("5,475.00");
    expect(fmtVolume(1_140_000)).toBe("1.14 M");
  });
});

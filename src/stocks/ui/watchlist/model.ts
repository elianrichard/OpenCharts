import type {
  DivScanRow,
  HoldingsReport,
  ListEntry,
  ScanReport,
  StochScanRow,
} from "../../types.ts";

/**
 * Turns the scan report, holdings and the user's own list into watchlist
 * sections. Pure: the component only renders what this returns.
 */

export type Tone = "pos" | "neg" | "warn" | "neutral";

export interface RowTag {
  text: string;
  tone: Tone;
  title: string;
}

export interface WatchRow {
  symbol: string;
  tag?: RowTag;
  held: boolean;
}

export type SectionId = "holdings" | "divbuy" | "stoch" | "watchlist" | "universe";

export interface WatchSection {
  id: SectionId;
  title: string;
  /** Shown when the section has no rows, in the trade's own words. */
  empty: string;
  rows: WatchRow[];
}

export function divTag(row: DivScanRow | undefined): RowTag | undefined {
  if (!row?.state) return undefined;
  if (row.state === "NEW") {
    return { text: "Buy", tone: "pos", title: `Divergence Buy: buy at the next open (${row.divSum} divergences)` };
  }
  if (row.state === "EXIT") {
    return { text: "Sell", tone: "neg", title: "Divergence Buy: sell at the next open (20 bars held)" };
  }
  const left = row.left ?? 0;
  return {
    text: `${left} left`,
    tone: "neutral",
    title: `Divergence Buy: holding, sells at the open in ${left} session${left === 1 ? "" : "s"}`,
  };
}

export function stochTag(row: StochScanRow | undefined): RowTag | undefined {
  if (!row?.stage || !row.fresh) return undefined;
  if (row.stage === "CONFIRMED") {
    return { text: "CNF", tone: "pos", title: "Stoch RSI 4-cross confirmed (weekly)" };
  }
  if (row.stage === "ARMED") {
    return { text: "ARM", tone: "warn", title: "Stoch RSI 4-cross armed, waiting to confirm (weekly)" };
  }
  return undefined;
}

const DIV_ORDER = { NEW: 0, EXIT: 1, HOLD: 2 } as const;

export function buildSections(input: {
  report: ScanReport | undefined;
  holdings: HoldingsReport | undefined;
  universe: ListEntry[] | undefined;
  watchlist: string[];
}): WatchSection[] {
  const div = new Map((input.report?.div ?? []).map((r) => [r.symbol, r]));
  const stoch = new Map((input.report?.stoch ?? []).map((r) => [r.symbol, r]));
  const held = new Set((input.holdings?.open ?? []).map((h) => h.symbol));
  const tagFor = (symbol: string) => divTag(div.get(symbol)) ?? stochTag(stoch.get(symbol));
  const row = (symbol: string, tag = tagFor(symbol)): WatchRow => ({
    symbol,
    tag,
    held: held.has(symbol),
  });

  const divRows = [...div.values()]
    .filter((r) => r.state)
    .sort(
      (a, b) =>
        DIV_ORDER[a.state!] - DIV_ORDER[b.state!] ||
        (a.state === "NEW" ? b.divSum - a.divSum : (a.left ?? 0) - (b.left ?? 0)) ||
        a.symbol.localeCompare(b.symbol),
    )
    .map((r) => row(r.symbol, divTag(r)));

  const stochRows = [...stoch.values()]
    .filter((r) => r.fresh && (r.stage === "CONFIRMED" || r.stage === "ARMED"))
    .sort(
      (a, b) =>
        (a.stage === "CONFIRMED" ? 0 : 1) - (b.stage === "CONFIRMED" ? 0 : 1) ||
        (a.daysSince ?? 0) - (b.daysSince ?? 0) ||
        a.symbol.localeCompare(b.symbol),
    )
    .map((r) => row(r.symbol, stochTag(r)));

  return [
    {
      id: "holdings",
      title: "Your positions",
      empty: "No open positions in the journal.",
      rows: (input.holdings?.open ?? []).map((h) => row(h.symbol)),
    },
    {
      id: "divbuy",
      title: "Divergence Buy",
      empty: "No buys, sells or open trades today.",
      rows: divRows,
    },
    {
      id: "stoch",
      title: "Stoch RSI 4-cross · 1W",
      empty: "No fresh weekly setups.",
      rows: stochRows,
    },
    {
      id: "watchlist",
      title: "Watchlist",
      empty: "Add a ticker with + to follow it here.",
      rows: input.watchlist.map((s) => row(s)),
    },
    {
      id: "universe",
      title: `Scan list · ${input.universe?.length ?? 0}`,
      empty: "list.txt is empty or missing.",
      rows: (input.universe ?? []).map((e) => row(e.symbol)),
    },
  ];
}

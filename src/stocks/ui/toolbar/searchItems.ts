import type { AssetInfo, ListEntry } from "../../types.ts";
import type { RowTag } from "../watchlist/model.ts";

export type SearchMode = "chart" | "compare" | "watchlist" | "grid";

export const SEARCH_TITLES: Record<SearchMode, string> = {
  chart: "Symbol search",
  compare: "Compare symbol",
  watchlist: "Add to watchlist",
  grid: "Chart in this cell",
};

export const TICKER = /^[A-Z][A-Z0-9]{0,5}([.-][A-Z])?$/;

export interface SearchItem {
  symbol: string;
  exchange?: string;
  name?: string;
  group: string;
  tag?: RowTag;
}

export function buildSearchItems(input: {
  universe: ListEntry[];
  assets: AssetInfo[];
  held: string[];
  watchlist: string[];
  tags: Map<string, RowTag>;
}): SearchItem[] {
  const names = new Map(input.assets.map((a) => [a.symbol, a]));
  const seen = new Set<string>();
  const items: SearchItem[] = [];
  const push = (symbol: string, group: string, exchange?: string) => {
    if (seen.has(symbol)) return;
    seen.add(symbol);
    const a = names.get(symbol);
    items.push({
      symbol,
      group,
      exchange: exchange ?? a?.exchange,
      name: a?.name && a.name !== symbol ? a.name : undefined,
      tag: input.tags.get(symbol),
    });
  };
  input.held.forEach((s) => push(s, "Your positions"));
  input.watchlist.forEach((s) => push(s, "Watchlist"));
  input.universe.forEach((e) => push(e.symbol, "Scan list", e.exchange));
  return items;
}

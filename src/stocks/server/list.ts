import type { ListEntry } from "../types.ts";

/**
 * trading-script/list.txt: one "EXCHANGE:SYMBOL" per line (TradingView style).
 * Blank lines and `#` comments are skipped, a bare "SYMBOL" gets an empty
 * exchange, and duplicates keep their first position. Symbols are upper-cased
 * with "-" as "." (BRK-B -> BRK.B), the form Alpaca uses.
 */
export function parseList(text: string): ListEntry[] {
  const out: ListEntry[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.lastIndexOf(":");
    const exchange = colon >= 0 ? line.slice(0, colon).trim().toUpperCase() : "";
    const symbol = (colon >= 0 ? line.slice(colon + 1) : line).trim().toUpperCase().replace(/-/g, ".");
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ exchange, symbol });
  }
  return out;
}

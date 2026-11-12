import { Search, X } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";
import { cn } from "../../../lib/utils.ts";
import { TagPill } from "../watchlist/Watchlist.tsx";
import { SEARCH_TITLES as TITLES, TICKER, type SearchItem, type SearchMode } from "./searchItems.ts";

/**
 * Symbol search. Lists the scan universe, your positions and watchlist with
 * their company names and scan tags; any other US ticker can be typed and
 * opened with Enter (Alpaca covers every listed US equity).
 */

export function SymbolSearch({
  mode,
  items,
  initialQuery = "",
  onPick,
  onClose,
}: {
  mode: SearchMode;
  items: SearchItem[];
  initialQuery?: string;
  onPick: (symbol: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const q = query.trim().toUpperCase();

  const results = useMemo(() => {
    if (!q) return items.slice(0, 80);
    const scored = items
      .map((it) => {
        const name = it.name?.toUpperCase() ?? "";
        const score = it.symbol === q ? 0 : it.symbol.startsWith(q) ? 1 : name.startsWith(q) ? 2 : it.symbol.includes(q) || name.includes(q) ? 3 : -1;
        return { it, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || a.it.symbol.localeCompare(b.it.symbol));
    return scored.slice(0, 80).map((x) => x.it);
  }, [items, q]);

  const typedNew = q && TICKER.test(q) && !results.some((r) => r.symbol === q);
  const rows: SearchItem[] = typedNew ? [{ symbol: q, group: "Any US ticker" }, ...results] : results;
  const safeActive = Math.min(active, Math.max(0, rows.length - 1));

  const pick = (symbol: string) => {
    onPick(symbol);
    onClose();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      const row = rows[safeActive];
      if (row) pick(row.symbol);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={TITLES[mode]}
        className="menu flex max-h-[70vh] w-full max-w-[560px] flex-col !p-0"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-11 items-center justify-between border-b border-[var(--edge)] px-4">
          <h2 className="text-[15px] font-semibold">{TITLES[mode]}</h2>
          <button type="button" className="tbtn !h-7 !px-1.5" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="relative border-b border-[var(--edge)] p-3">
          <Search className="pointer-events-none absolute left-6 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--mute)]" />
          <input
            autoFocus
            className="field w-full !pl-9 uppercase placeholder:normal-case"
            placeholder="Ticker or company, e.g. AVGO"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
            aria-label="Search symbols"
          />
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto py-1" role="listbox">
          {rows.length === 0 && (
            <p className="px-4 py-6 text-center text-[13px] text-[var(--mute)]">
              No match. Type a full US ticker and press Enter.
            </p>
          )}
          {rows.map((r, i) => {
            const header = i === 0 || rows[i - 1]!.group !== r.group ? r.group : null;
            return (
              <div key={`${r.group}:${r.symbol}`}>
                {header && <div className="px-4 pb-1 pt-2 text-[11px] text-[var(--mute)]">{header}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === safeActive}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(r.symbol)}
                  className={cn(
                    "flex h-9 w-full items-center gap-3 px-4 text-left text-[13px]",
                    i === safeActive && "bg-[#2a292d]",
                  )}
                >
                  <span className="w-16 shrink-0 font-semibold">{r.symbol}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--ink-2)]">
                    {r.name ?? (r.group === "Any US ticker" ? "Open this ticker" : "")}
                  </span>
                  {r.tag && <TagPill tag={r.tag} />}
                  <span className="w-16 shrink-0 text-right text-[11px] text-[var(--mute)]">{r.exchange ?? ""}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

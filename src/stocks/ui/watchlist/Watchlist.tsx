import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../../lib/utils.ts";
import { fmtPct, fmtPrice, fmtSigned, polarity } from "../format.ts";
import { getSnapshot, useSnapshotVersion } from "../market.ts";
import { useStocksUi, type FlagColor } from "../store.ts";
import type { RowTag, WatchRow, WatchSection } from "./model.ts";

/**
 * TradingView-style watchlist with sections. Columns: Symbol, Last, Chg,
 * Chg%. Only Chg% carries polarity colour — it is the "what moved today"
 * column; every other figure stays ink or grey and carries its sign.
 */

type SortKey = "symbol" | "last" | "chg" | "chgPct";
type SortDir = "asc" | "desc";

const FLAG_COLORS: Record<FlagColor, string> = {
  red: "#e5566f",
  amber: "#d9a441",
  green: "#44a282",
  blue: "#4a8ad6",
};

export function TagPill({ tag }: { tag: RowTag }) {
  return (
    <span className={`pill pill-${tag.tone}`} title={tag.title}>
      {tag.text}
    </span>
  );
}

function sortRows(rows: WatchRow[], key: SortKey | null, dir: SortDir): WatchRow[] {
  if (!key) return rows;
  const val = (r: WatchRow): number | string => {
    if (key === "symbol") return r.symbol;
    const s = getSnapshot(r.symbol);
    const v = key === "last" ? s?.last : key === "chg" ? s?.change : s?.changePct;
    return v ?? Number.NEGATIVE_INFINITY;
  };
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (typeof va === "string" && typeof vb === "string") return sign * va.localeCompare(vb);
    return sign * ((va as number) - (vb as number));
  });
}

export function Watchlist({
  sections,
  selected,
  onSelect,
  onAdd,
  loading,
}: {
  sections: WatchSection[];
  selected: string;
  onSelect: (symbol: string) => void;
  onAdd: () => void;
  loading: { scans: boolean; holdings: boolean };
}) {
  useSnapshotVersion();
  const collapsed = useStocksUi((s) => s.collapsed);
  const toggleCollapsed = useStocksUi((s) => s.toggleCollapsed);
  const flags = useStocksUi((s) => s.flags);
  const cycleFlag = useStocksUi((s) => s.cycleFlag);
  const removeFromWatchlist = useStocksUi((s) => s.removeFromWatchlist);
  const [sort, setSort] = useState<{ key: SortKey | null; dir: SortDir }>({ key: null, dir: "desc" });
  const listRef = useRef<HTMLDivElement>(null);

  // The universe starts folded: 150 rows would bury the sections that need action.
  const isCollapsed = (id: string) => collapsed[id] ?? id === "universe";

  const visibleSymbols = useMemo(
    () =>
      sections.flatMap((s) =>
        isCollapsed(s.id) ? [] : sortRows(s.rows, sort.key, sort.dir).map((r) => r.symbol),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections, collapsed, sort],
  );

  const onHeader = (key: SortKey) =>
    setSort((s) =>
      s.key !== key
        ? { key, dir: key === "symbol" ? "asc" : "desc" }
        : s.dir === (key === "symbol" ? "asc" : "desc")
          ? { key, dir: key === "symbol" ? "desc" : "asc" }
          : { key: null, dir: "desc" },
    );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = visibleSymbols.indexOf(selected);
    const next =
      e.key === "ArrowDown"
        ? visibleSymbols[Math.min(visibleSymbols.length - 1, i + 1)]
        : visibleSymbols[Math.max(0, i - 1)];
    if (next) {
      onSelect(next);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-symbol="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  };

  const head = (key: SortKey, label: string, cls: string) => (
    <button
      type="button"
      onClick={() => onHeader(key)}
      className={cn("sel h-full hover:text-[var(--ink)]", cls)}
      data-on={sort.key === key}
      aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      title={`Sort by ${label}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <h2 className="text-[14px] font-semibold">Watchlist</h2>
        <button type="button" className="tbtn !h-7 !px-1.5" onClick={onAdd} aria-label="Add symbol" title="Add symbol">
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <div
        className="grid h-7 shrink-0 grid-cols-[minmax(0,1fr)_64px_56px_60px] items-stretch gap-x-2 border-b border-[var(--rule)] px-3 text-[11px] text-[var(--mute)]"
        role="row"
      >
        {head("symbol", "Symbol", "text-left")}
        {head("last", "Last", "text-right")}
        {head("chg", "Chg", "text-right")}
        {head("chgPct", "Chg%", "text-right")}
      </div>

      <div
        ref={listRef}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-2"
        role="grid"
        aria-label="Watchlist"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {sections.map((section) => {
          const folded = isCollapsed(section.id);
          const waiting =
            ((section.id === "divbuy" || section.id === "stoch") && loading.scans) ||
            (section.id === "holdings" && loading.holdings);
          return (
            <section key={section.id} aria-label={section.title}>
              <button
                type="button"
                onClick={() => toggleCollapsed(section.id)}
                className="flex h-8 w-full items-center gap-1 px-2 text-[12px] text-[var(--mute)] hover:text-[var(--ink)]"
                aria-expanded={!folded}
              >
                {folded ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                <span className="font-medium">{section.title}</span>
                <span className="num ml-auto text-[11px]">{waiting ? "…" : section.rows.length}</span>
              </button>
              {!folded &&
                (section.rows.length === 0 ? (
                  <p className="px-6 pb-2 text-[12px] text-[var(--mute)]">
                    {waiting ? "Loading…" : section.empty}
                  </p>
                ) : (
                  sortRows(section.rows, sort.key, sort.dir).map((row) => (
                    <WatchRowView
                      key={`${section.id}:${row.symbol}`}
                      row={row}
                      selected={row.symbol === selected}
                      flag={flags[row.symbol]}
                      onSelect={() => onSelect(row.symbol)}
                      onFlag={() => cycleFlag(row.symbol)}
                      onRemove={
                        section.id === "watchlist" ? () => removeFromWatchlist(row.symbol) : undefined
                      }
                    />
                  ))
                ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function WatchRowView({
  row,
  selected,
  flag,
  onSelect,
  onFlag,
  onRemove,
}: {
  row: WatchRow;
  selected: boolean;
  flag: FlagColor | undefined;
  onSelect: () => void;
  onFlag: () => void;
  onRemove?: () => void;
}) {
  const snap = getSnapshot(row.symbol);
  const pol = polarity(snap?.changePct);
  return (
    <div
      role="row"
      data-symbol={row.symbol}
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "group relative grid h-8 cursor-pointer grid-cols-[minmax(0,1fr)_64px_56px_60px] items-center gap-x-2 px-3 text-[13px]",
        selected ? "row-selected" : "row-hover",
      )}
    >
      {/* Flag: a 3px edge in the flag's colour. Click the edge to cycle it. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onFlag();
        }}
        className="absolute inset-y-0 left-0 w-2"
        aria-label={flag ? `Flag: ${flag}. Change flag` : `Flag ${row.symbol}`}
        title="Flag"
      >
        <span
          className={cn("absolute inset-y-1 left-0 w-[3px] rounded-r", !flag && "group-hover:bg-[var(--control)]")}
          style={flag ? { background: FLAG_COLORS[flag] } : undefined}
        />
      </button>
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        <span className="shrink-0 font-semibold">{row.symbol}</span>
        {row.held && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ink-2)]" title="You hold this" aria-label="You hold this" />
        )}
        {snap?.extended && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full border border-[var(--warn)]"
            title={`${snap.extended.session === "pre" ? "Pre-market" : "After hours"} ${fmtPrice(snap.extended.price)} (${fmtPct(snap.extended.changePct)})`}
            aria-label={snap.extended.session === "pre" ? "Pre-market trade" : "After-hours trade"}
          />
        )}
        {row.tag && (
          <span className="min-w-0 shrink overflow-hidden">
            <TagPill tag={row.tag} />
          </span>
        )}
      </div>
      <span className="num text-right">{fmtPrice(snap?.last)}</span>
      <span className="num text-right text-[var(--ink-2)]">{fmtSigned(snap?.change)}</span>
      <span
        className="num text-right"
        style={{ color: pol > 0 ? "var(--pos)" : pol < 0 ? "var(--neg)" : "var(--ink-2)" }}
      >
        {fmtPct(snap?.changePct)}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded bg-[var(--raised)] p-1 text-[var(--mute)] hover:text-[var(--ink)] group-hover:block"
          aria-label={`Remove ${row.symbol} from watchlist`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

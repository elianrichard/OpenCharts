import { Check, Search, X } from "lucide-react";
import { useState } from "react";
import type { IndicatorType } from "../../../lib/indicators.ts";
import type { OverlayId } from "../store.ts";

/**
 * Indicators, grouped the way the user reads them: their own strategies
 * first, then the overlays and oscillators they chart them with, then the
 * terminal's built-ins. Every row toggles in place; the dialog stays open.
 */

interface Item {
  key: string;
  title: string;
  detail: string;
  on: boolean;
  toggle: () => void;
}

export function IndicatorsDialog({
  overlays,
  onToggleOverlay,
  activeIndicators,
  onToggleIndicator,
  onClose,
}: {
  overlays: Record<OverlayId, boolean>;
  onToggleOverlay: (id: OverlayId) => void;
  activeIndicators: IndicatorType[];
  onToggleIndicator: (t: IndicatorType) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const ov = (id: OverlayId, title: string, detail: string): Item => ({
    key: id,
    title,
    detail,
    on: overlays[id],
    toggle: () => onToggleOverlay(id),
  });
  const bi = (t: IndicatorType, title: string, detail: string): Item => ({
    key: t,
    title,
    detail,
    on: activeIndicators.includes(t),
    toggle: () => onToggleIndicator(t),
  });

  const groups: { title: string; items: Item[] }[] = [
    {
      title: "Your strategies",
      items: [
        ov("divBuy", "Divergence Buy (validated)", "Daily · ≥3 bullish divergences in 4 bars, IBS ≤ 0.25, sell 20 bars later"),
        ov("stoch4x", "Stoch RSI 4-cross", "Weekly · ARM and CNF markers from the 4-cross pattern"),
      ],
    },
    {
      title: "Overlays",
      items: [
        ov("emaRibbon", "EMA ribbon", "EMA 20 · 50 · 100 · 200"),
        ov("divLines", "Divergences", "Regular divergences on 10 oscillators (MACD, Hist, RSI, Stoch, CCI, MOM, OBV, VWMACD, CMF, MFI)"),
        bi("SMA", "Simple moving average", "SMA 20"),
        bi("EMA", "Exponential moving average", "EMA 20"),
        bi("BOLL", "Bollinger Bands", "20 · 2σ"),
        bi("VWAP", "VWAP", "Session volume-weighted average price"),
      ],
    },
    {
      title: "Oscillators (own pane)",
      items: [
        ov("stochRsi", "Stochastic RSI", "RSI 14 · Stoch 14 · K 5 · D 5, the 4-cross scan's settings"),
        bi("RSI", "Relative Strength Index", "RSI 14"),
        bi("MACD", "MACD", "12 · 26 · 9"),
        bi("STOCH", "Stochastic", "14 · 3"),
        bi("ATR", "Average True Range", "ATR 14"),
      ],
    },
  ];

  const q = query.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => !q || `${i.title} ${i.detail}`.toLowerCase().includes(q)),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Indicators"
        className="menu flex max-h-[72vh] w-full max-w-[560px] flex-col !p-0"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="flex h-11 items-center justify-between border-b border-[var(--edge)] px-4">
          <h2 className="text-[15px] font-semibold">Indicators</h2>
          <button type="button" className="tbtn !h-7 !px-1.5" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="relative border-b border-[var(--edge)] p-3">
          <Search className="pointer-events-none absolute left-6 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--mute)]" />
          <input
            autoFocus
            className="field w-full !pl-9"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search indicators"
          />
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-2">
          {filtered.map((g) => (
            <div key={g.title}>
              <div className="px-4 pb-1 pt-3 text-[11px] text-[var(--mute)]">{g.title}</div>
              {g.items.map((i) => (
                <button
                  key={i.key}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={i.on}
                  onClick={i.toggle}
                  className="row-hover flex min-h-10 w-full items-center gap-3 px-4 py-1.5 text-left"
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border border-[var(--control)]">
                    {i.on && <Check className="h-3 w-3 text-[var(--line-accent)]" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px]">{i.title}</span>
                    <span className="block truncate text-[11px] text-[var(--mute)]">{i.detail}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
          {filtered.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-[var(--mute)]">No indicator matches "{query}".</p>}
        </div>
      </div>
    </div>
  );
}

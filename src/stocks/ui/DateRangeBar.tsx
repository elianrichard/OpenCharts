import { useEffect, useState } from "react";
import { RANGE_PRESETS, usSession, type RangePreset } from "./range.ts";

/**
 * Range presets under the chart (TradingView's 1D … All). Each picks a
 * sensible interval for its span, then frames that span. The right end shows
 * the New York clock and the session, since every stock signal here is about
 * the next open.
 */

export function DateRangeBar({
  active,
  onPick,
}: {
  active: string | null;
  onPick: (preset: RangePreset) => void;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const { clock, session } = usSession(now);

  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-t border-[var(--edge)] bg-[var(--surface)] px-2 text-[12px] [scrollbar-width:none]">
      {RANGE_PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          className="tbtn sel !h-7 !px-2 text-[12px] [--sel-inset:8px]"
          data-on={active === p.id}
          aria-pressed={active === p.id}
          onClick={() => onPick(p)}
          title={`Show ${p.label === "All" ? "all history" : p.label} on ${p.timeframe}`}
        >
          {p.label}
        </button>
      ))}
      <span className="ml-auto flex shrink-0 items-center gap-3 pl-3 text-[var(--mute)]">
        <span className="hidden sm:inline" title="US equity session in New York (holidays not shown)">
          <span
            className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
            style={{ background: session === "Market open" ? "var(--pos)" : session === "Market closed" ? "var(--control)" : "var(--warn)" }}
          />
          {session}
        </span>
        <span className="num">{clock}</span>
        <span title="Prices adjusted for splits and dividends (Alpaca adjustment=all), as in the scans">ADJ</span>
      </span>
    </div>
  );
}

import type { Timeframe } from "../../pages/trading/constants.ts";

export interface RangePreset {
  id: string;
  label: string;
  timeframe: Timeframe;
  /** Span in days; "ytd" from Jan 1; "all" fits everything loaded. */
  span: number | "ytd" | "all";
}

export const RANGE_PRESETS: RangePreset[] = [
  { id: "1D", label: "1D", timeframe: "5m", span: 1 },
  { id: "5D", label: "5D", timeframe: "15m", span: 5 },
  { id: "1M", label: "1M", timeframe: "1h", span: 31 },
  { id: "3M", label: "3M", timeframe: "4h", span: 92 },
  { id: "6M", label: "6M", timeframe: "1d", span: 183 },
  { id: "YTD", label: "YTD", timeframe: "1d", span: "ytd" },
  { id: "1Y", label: "1Y", timeframe: "1d", span: 365 },
  { id: "5Y", label: "5Y", timeframe: "1w", span: 365 * 5 },
  { id: "All", label: "All", timeframe: "1w", span: "all" },
];

/** Visible range for a preset, ending at the last bar. null = fit content. */
export function presetRange(preset: RangePreset, lastBarSec: number): { from: number; to: number } | null {
  if (preset.span === "all") return null;
  if (preset.span === "ytd") {
    const year = new Date(lastBarSec * 1000).getUTCFullYear();
    return { from: Date.UTC(year, 0, 1) / 1000, to: lastBarSec };
  }
  return { from: lastBarSec - preset.span * 86_400, to: lastBarSec };
}

const nyParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export type Session = "Pre-market" | "Market open" | "After hours" | "Market closed";

/** US equity session at an instant. Exchange holidays are not modelled. */
export function usSession(now: Date): { clock: string; session: Session } {
  const parts = Object.fromEntries(nyParts.formatToParts(now).map((p) => [p.type, p.value]));
  const h = Number(parts.hour) % 24;
  const m = Number(parts.minute);
  const minutes = h * 60 + m;
  const weekend = parts.weekday === "Sat" || parts.weekday === "Sun";
  const clock = `${String(h).padStart(2, "0")}:${parts.minute}:${parts.second} ET`;
  if (weekend) return { clock, session: "Market closed" };
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return { clock, session: "Pre-market" };
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return { clock, session: "Market open" };
  if (minutes >= 16 * 60 && minutes < 20 * 60) return { clock, session: "After hours" };
  return { clock, session: "Market closed" };
}

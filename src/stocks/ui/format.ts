/**
 * Number and date formatting for the workspace. Figures carry their sign in
 * the text ("+2.31", "−0.95%"), so meaning survives without colour. A missing
 * value is an en dash, a zero prints as a zero.
 */

export const DASH = "–";
const MINUS = "−";

export function fmtPrice(v: number | null | undefined, digits?: number): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const d = digits ?? (Math.abs(v) < 1 ? 4 : 2);
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtSigned(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const s = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (v > 0) return `+${s}`;
  if (v < 0) return `${MINUS}${s}`;
  return s;
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return `${fmtSigned(v, digits)}%`;
}

/** Unsigned percentage, e.g. a win rate. */
export function fmtRate(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtMoney(v: number | null | undefined, signed = false): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const abs = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (!signed) return `${v < 0 ? MINUS : ""}$${abs}`;
  if (v > 0) return `+$${abs}`;
  if (v < 0) return `${MINUS}$${abs}`;
  return `$${abs}`;
}

export function fmtVolume(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)} B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)} M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)} K`;
  return v.toFixed(0);
}

export function fmtQty(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return Number.isInteger(v)
    ? v.toLocaleString("en-US")
    : v.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

const NY = "America/New_York";
const isoDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: NY,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const shortDay = new Intl.DateTimeFormat("en-US", { timeZone: NY, month: "short", day: "numeric" });
const timeOfDay = new Intl.DateTimeFormat("en-US", {
  timeZone: NY,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Bar time (unix seconds) → "2026-11-11", the trading day in New York. */
export function fmtDay(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return DASH;
  return isoDay.format(new Date(sec * 1000));
}

/** Bar time (unix seconds) → "Nov 11". */
export function fmtShortDay(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return DASH;
  return shortDay.format(new Date(sec * 1000));
}

/** Epoch ms → "15:42 ET". */
export function fmtClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return DASH;
  return `${timeOfDay.format(new Date(ms))} ET`;
}

/** +1 / −1 / 0 for colouring a change by polarity. */
export function polarity(v: number | null | undefined): -1 | 0 | 1 {
  if (v == null || !Number.isFinite(v) || v === 0) return 0;
  return v > 0 ? 1 : -1;
}

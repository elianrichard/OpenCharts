/**
 * Reader for trading-script/dashboard/data/journal.json, plus a port of the
 * dashboard's fill-line parser (dashboard/src/lib/trades/parse.ts), which
 * understands the Telegram buy format from railway/holdings.py plus sells:
 *
 *   buy AVGO                     buy AVGO 10            bought AVGO 10 @ 334.19
 *   buy 10 AVGO @ 334.19         buy AVGO PDD MSFT      /buy AVGO 10 at $334.19
 *   sell AVGO 10 @ 350           sold AVGO @ 350        (no qty = the whole position)
 *
 * "$AVGO" and "NASDAQ:AVGO" work; buy/bought/beli and sell/sold/jual;
 * case-insensitive; "1,000" = 1000 and "334,19" = 334.19.
 *
 * Pure: the dev server reads the file and hands the parsed JSON in.
 */

export type Side = "buy" | "sell";

/** One recorded buy or sell. qty/price null = not given (like holdings.py). */
export interface JournalFill {
  id: string;
  side: Side;
  ticker: string;
  qty: number | null;
  price: number | null;
  /** US trading day, YYYY-MM-DD */
  date: string;
  /** The line typed in the dashboard composer, if any. */
  source?: string;
  createdAt: string;
}

export interface ManualPrice {
  price: number;
  date: string;
}

export interface ParsedJournal {
  fills: JournalFill[];
  /** Prices typed for tickers the scan does not cover. */
  prices: Record<string, ManualPrice>;
  /** Entries that could not be used, in journal order. */
  warnings: string[];
}

// ── Line parser (port of parse.ts) ────────────────────────

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const TICK = String.raw`\$?(?:[A-Za-z]+:)?[A-Za-z][A-Za-z0-9]{0,5}(?:[.\-][A-Za-z])?`;
const UNIT = String.raw`(?:\s*(?:shares?|sh|lots?)\b)?`;
const PRICE = String.raw`(?:\s*(?:@|\bat\b)\s*\$?(?<p>${NUM}))?`;

const VERB = /^\/?(?<verb>buy|bought|beli|sell|sold|jual)(?:@\w+)?(?:\s+|:\s*)(?<rest>.+)$/i;
const TICK_FIRST = new RegExp(String.raw`^(?<t>${TICK})(?:\s+(?<q>${NUM})${UNIT})?${PRICE}$`, "i");
const QTY_FIRST = new RegExp(String.raw`^(?<q>${NUM})${UNIT}\s+(?<t>${TICK})${PRICE}$`, "i");
const TICK_ONLY = new RegExp(String.raw`^${TICK}$`, "i");

export interface ParsedFill {
  side: Side;
  ticker: string;
  qty: number | null;
  price: number | null;
}

export type ParsedLine =
  | { line: string; ok: true; fills: ParsedFill[] }
  | { line: string; ok: false; reason: string };

export function parseNumber(s: string): number {
  let v = s;
  if (v.includes(",") && !v.includes(".") && v.split(",").pop()!.length !== 3) {
    v = v.replace(",", ".");
  }
  return Number(v.replace(/,/g, ""));
}

export function normalizeTicker(s: string): string {
  return s.replace(/^\$/, "").split(":").pop()!.toUpperCase().replace(/-/g, ".");
}

export function parseLine(raw: string): ParsedLine {
  const line = raw.trim();
  const m = line.match(VERB);
  if (!m?.groups) return { line, ok: false, reason: "Start with buy or sell" };
  const verb = m.groups.verb!.toLowerCase();
  const side: Side = ["sell", "sold", "jual"].includes(verb) ? "sell" : "buy";
  const rest = m.groups.rest!.trim();

  const one = rest.match(TICK_FIRST) ?? rest.match(QTY_FIRST);
  if (one?.groups) {
    const qty = one.groups.q ? parseNumber(one.groups.q) : null;
    const price = one.groups.p ? parseNumber(one.groups.p) : null;
    if (qty !== null && !(qty > 0)) return { line, ok: false, reason: "Quantity must be above 0" };
    if (price !== null && !(price > 0)) return { line, ok: false, reason: "Price must be above 0" };
    return { line, ok: true, fills: [{ side, ticker: normalizeTicker(one.groups.t!), qty, price }] };
  }

  const parts = rest.split(/[\s,]+/).filter(Boolean);
  if (parts.length && parts.every((p) => TICK_ONLY.test(p))) {
    return {
      line,
      ok: true,
      fills: parts.map((p) => ({ side, ticker: normalizeTicker(p), qty: null, price: null })),
    };
  }
  return { line, ok: false, reason: "Use buy TICKER [qty] [@ price]" };
}

/** Split pasted text into parsed lines; blank lines and /start, /help are skipped. */
export function parseText(text: string): ParsedLine[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\/(?:start|help)\b/i.test(l))
    .map(parseLine);
}

/** The line you'd type for a fill. */
export function formatLine(f: ParsedFill): string {
  let s = `${f.side} ${f.ticker}`;
  if (f.qty != null) s += ` ${f.qty}`;
  if (f.price != null) s += ` @ ${f.price}`;
  return s;
}

// ── journal.json ──────────────────────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** null/undefined -> null, numbers and numeric strings -> number, else NaN. */
function optionalNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseNumber(v.trim());
  return Number.NaN;
}

function label(entry: Record<string, unknown>, index: number): string {
  const source = typeof entry.source === "string" && entry.source.trim() ? entry.source.trim() : null;
  const date = typeof entry.date === "string" ? `${entry.date} ` : "";
  if (source) return `${date}"${source}"`;
  const side = typeof entry.side === "string" ? entry.side : "?";
  const ticker = typeof entry.ticker === "string" ? entry.ticker : "?";
  return `${date}${side} ${ticker} (fill #${index + 1})`;
}

/**
 * Validate the journal file. Fills the dashboard wrote are used as they are;
 * a fill missing structured fields falls back to re-parsing its `source` line.
 * Anything unusable becomes a warning instead of an exception.
 */
export function parseJournal(raw: unknown): ParsedJournal {
  const out: ParsedJournal = { fills: [], prices: {}, warnings: [] };
  if (!isRecord(raw) || !Array.isArray(raw.fills)) {
    out.warnings.push('journal.json: expected an object like {"version": 1, "fills": [...]}');
    return out;
  }
  if (raw.version !== 1) out.warnings.push(`journal.json: unknown version ${String(raw.version)}, reading it as version 1`);

  raw.fills.forEach((entry: unknown, index: number) => {
    if (!isRecord(entry)) {
      out.warnings.push(`Fill #${index + 1}: not an object`);
      return;
    }
    const where = label(entry, index);
    const date = typeof entry.date === "string" ? entry.date.trim() : "";
    if (!DATE.test(date)) {
      out.warnings.push(`${where}: missing or invalid date`);
      return;
    }

    let side: Side | null = entry.side === "buy" || entry.side === "sell" ? entry.side : null;
    let ticker = typeof entry.ticker === "string" && entry.ticker.trim() ? normalizeTicker(entry.ticker.trim()) : null;
    let qty = optionalNumber(entry.qty);
    let price = optionalNumber(entry.price);

    if ((!side || !ticker) && typeof entry.source === "string") {
      const parsed = parseLine(entry.source);
      if (!parsed.ok) {
        out.warnings.push(`${where}: ${parsed.reason}`);
        return;
      }
      if (parsed.fills.length !== 1) {
        out.warnings.push(`${where}: names several tickers; record them as separate fills`);
        return;
      }
      const fill = parsed.fills[0]!;
      side ??= fill.side;
      ticker ??= fill.ticker;
      if (entry.qty == null) qty = fill.qty;
      if (entry.price == null) price = fill.price;
    }

    if (!side) {
      out.warnings.push(`${where}: side must be "buy" or "sell"`);
      return;
    }
    if (!ticker) {
      out.warnings.push(`${where}: missing ticker`);
      return;
    }
    if (qty !== null && !(qty > 0)) {
      out.warnings.push(`${where}: quantity must be above 0`);
      return;
    }
    if (price !== null && !(price > 0)) {
      out.warnings.push(`${where}: price must be above 0`);
      return;
    }

    out.fills.push({
      id: typeof entry.id === "string" && entry.id ? entry.id : `fill-${index + 1}`,
      side,
      ticker,
      qty,
      price,
      date,
      ...(typeof entry.source === "string" ? { source: entry.source } : {}),
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
    });
  });

  if (isRecord(raw.prices)) {
    for (const [key, value] of Object.entries(raw.prices)) {
      if (!isRecord(value)) continue;
      const price = optionalNumber(value.price);
      if (price != null && price > 0 && typeof value.date === "string") {
        out.prices[normalizeTicker(key)] = { price, date: value.date };
      }
    }
  }
  return out;
}

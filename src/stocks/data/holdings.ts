import type { ClosedTrade, Holding, HoldingsReport } from "../types.ts";
import { parseJournal, type JournalFill } from "./journal.ts";

/**
 * Port of trading-script/dashboard/src/lib/trades/positions.ts, with the same
 * semantics:
 *
 * Replays the journal per ticker, average-cost method. A position opens on the
 * first buy and closes when a sell takes it back to zero (or a sell has no qty,
 * which means "all of it"). P/L follows railway/holdings.py: % from the average
 * price, $ only over buys that have both qty and price, and no P/L when the last
 * price is over ODD_RATIO x off the average (a split, a non-US ticker or a typo).
 *
 * Pure. The dev server reads journal.json on every request and runs it through
 * `holdingsFromJournal`.
 */

export const ODD_RATIO = 3;
const EPS = 1e-9;

interface Cycle {
  ticker: string;
  since: string;
  /** Total shares from buys that gave a qty, after sells. */
  qty: number;
  /** Some buys had no qty, so qty is a lower bound. */
  qtyPartial: boolean;
  /** qty/cost over buys with both qty and price, after sells. */
  pricedQty: number;
  cost: number;
  avg: number | null;
  buys: number;
  pricedBuys: number;
  realized: number;
  prices: number[];
  soldQty: number;
  soldValue: number;
  soldCost: number;
  /** Shares bought over the cycle; null once a buy had no qty. */
  boughtQty: number | null;
  /** Shares bought over the cycle from buys that gave a qty. */
  knownBoughtQty: number;
}

/** A fill the engine had to skip, keyed by fill id. */
export interface BookIssue {
  fill: JournalFill;
  reason: string;
}

export interface Book {
  open: Holding[];
  closed: ClosedTrade[];
  issues: BookIssue[];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "");
}

export function sortFills(fills: JournalFill[]): JournalFill[] {
  // code-point order, not localeCompare: ICU collation puts symbols before digits
  return [...fills].sort((a, b) => cmp(a.date, b.date) || cmp(a.createdAt, b.createdAt));
}

function averageOf(c: Cycle): number | null {
  if (c.pricedQty > 0) return c.cost / c.pricedQty;
  if (c.prices.length) return c.prices.reduce((s, p) => s + p, 0) / c.prices.length;
  return null;
}

function newCycle(f: JournalFill): Cycle {
  return {
    ticker: f.ticker,
    since: f.date,
    qty: 0,
    qtyPartial: false,
    pricedQty: 0,
    cost: 0,
    avg: null,
    buys: 0,
    pricedBuys: 0,
    realized: 0,
    prices: [],
    soldQty: 0,
    soldValue: 0,
    soldCost: 0,
    boughtQty: 0,
    knownBoughtQty: 0,
  };
}

function toHolding(c: Cycle): Holding {
  return {
    symbol: c.ticker,
    shares: c.qty,
    avgPrice: c.avg,
    cost: c.cost,
    since: c.since,
    buys: c.buys,
    partial: c.pricedBuys < c.buys,
  };
}

export function buildBook(fills: JournalFill[]): Book {
  const cycles = new Map<string, Cycle>();
  const closed: ClosedTrade[] = [];
  const issues: BookIssue[] = [];

  for (const f of sortFills(fills)) {
    let c = cycles.get(f.ticker);
    if (f.side === "buy") {
      if (!c) {
        c = newCycle(f);
        cycles.set(f.ticker, c);
      }
      c.buys++;
      if (f.qty != null) {
        c.qty += f.qty;
        c.knownBoughtQty += f.qty;
        if (c.boughtQty != null) c.boughtQty += f.qty;
        if (f.price != null) {
          c.cost += f.qty * f.price;
          c.pricedQty += f.qty;
          c.pricedBuys++;
        }
      } else {
        c.qtyPartial = true;
        c.boughtQty = null;
      }
      if (f.price != null) c.prices.push(f.price);
      c.avg = averageOf(c);
      continue;
    }

    // sell
    if (!c) {
      issues.push({ fill: f, reason: `No open ${f.ticker} position to sell` });
      continue;
    }
    if (f.qty != null && !c.qtyPartial && f.qty > c.qty + EPS) {
      issues.push({ fill: f, reason: `Sells ${fmt(f.qty)}, but only ${fmt(c.qty)} ${f.ticker} were held` });
      continue;
    }
    const closesAll = f.qty == null || (!c.qtyPartial && c.qty - f.qty <= EPS);
    const sold = f.qty ?? (c.qtyPartial ? null : c.qty);
    if (sold != null && sold > 0) {
      if (c.avg != null && f.price != null) {
        // shares from unpriced buys carry no cost, so only the priced share realizes $
        const pricedShare = c.qty > 0 ? sold * (c.pricedQty / c.qty) : 0;
        c.realized += pricedShare * (f.price - c.avg);
        c.soldCost += pricedShare * c.avg;
      }
      if (f.price != null) {
        c.soldQty += sold;
        c.soldValue += sold * f.price;
      }
      const keep = c.qty > 0 ? Math.max(0, 1 - sold / c.qty) : 0;
      c.qty = Math.max(0, c.qty - sold);
      c.cost *= keep;
      c.pricedQty *= keep;
    } else if (f.price != null) {
      // whole position, size unknown: % only
      c.soldQty += 1;
      c.soldValue += f.price;
    }

    if (closesAll) {
      const avgExit = c.soldQty ? c.soldValue / c.soldQty : null;
      const avgEntry = c.avg;
      closed.push({
        symbol: c.ticker,
        openedOn: c.since,
        closedOn: f.date,
        // The dashboard leaves this null when a buy had no qty; the contract
        // wants a number, so fall back to the shares that were stated.
        shares: c.boughtQty ?? c.knownBoughtQty,
        avgEntry,
        avgExit,
        realized: c.soldCost > 0 ? c.realized : null,
        realizedPct:
          c.soldCost > 0
            ? (c.realized / c.soldCost) * 100
            : avgEntry && avgExit
              ? (avgExit / avgEntry - 1) * 100
              : null,
      });
      cycles.delete(f.ticker);
    }
  }

  const open = [...cycles.values()].map(toHolding).sort((a, b) => a.symbol.localeCompare(b.symbol));
  closed.sort((a, b) => cmp(b.closedOn, a.closedOn) || a.symbol.localeCompare(b.symbol));
  return { open, closed, issues };
}

function describeFill(f: JournalFill): string {
  if (f.source?.trim()) return `${f.date} "${f.source.trim()}"`;
  let s = `${f.date} ${f.side} ${f.ticker}`;
  if (f.qty != null) s += ` ${fmt(f.qty)}`;
  if (f.price != null) s += ` @ ${f.price}`;
  return s;
}

/** journal.json (already JSON-parsed) -> what /stocks-api/holdings serves. */
export function holdingsFromJournal(raw: unknown): HoldingsReport {
  const journal = parseJournal(raw);
  const book = buildBook(journal.fills);
  return {
    open: book.open,
    closed: book.closed,
    warnings: [...journal.warnings, ...book.issues.map((i) => `${describeFill(i.fill)}: ${i.reason}`)],
  };
}

export interface HoldingPnl {
  pct: number | null;
  usd: number | null;
  /** Some buys lack qty or price; $ counts the rest. */
  partial: boolean;
  /** Last price over ODD_RATIO x off the average: no P/L, leave it out of totals. */
  odd: boolean;
}

/**
 * Open P/L at `last`, as the dashboard's pnl(). The priced share count is
 * cost / avgPrice: both scale together on sells, so the ratio is exact.
 */
export function holdingPnl(h: Holding, last: number | null): HoldingPnl {
  if (last == null || h.avgPrice == null) return { pct: null, usd: null, partial: false, odd: false };
  const ratio = last / h.avgPrice;
  if (ratio < 1 / ODD_RATIO || ratio > ODD_RATIO) return { pct: null, usd: null, partial: false, odd: true };
  const pct = (ratio - 1) * 100;
  const pricedShares = h.cost > 0 ? h.cost / h.avgPrice : 0;
  if (!(pricedShares > 0)) return { pct, usd: null, partial: false, odd: false };
  return { pct, usd: pricedShares * last - h.cost, partial: h.partial, odd: false };
}

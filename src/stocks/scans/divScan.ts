/**
 * Divergence Buy — port of trading-script/railway/div_scan.py, plus the
 * strategy tester view of pine/strategies/divergence-buy.pine.
 *
 * Rule: >= DIV_MIN positive regular divergences summed over the last
 * DIV_WINDOW daily bars, on a bar that closes in the bottom IBS_MAX of its
 * range -> buy at the next open, sell at the open HOLD_BARS bars after entry.
 * One position at a time; signals while holding are ignored (pyramiding=0).
 */
import type { Bar, DivScanRow, StrategyMarker, StrategyResult, StrategyStats, StrategyTrade } from "../types.ts";
import { regularDivergence } from "./divergence.ts";
import { rollingSum } from "./indicators.ts";

// pine input defaults — keep in sync with div_scan.py / divergence-buy.pine
export const DIV_MIN = 3;
export const DIV_WINDOW = 4;
export const HOLD_BARS = 20;
export const IBS_MAX = 0.25;
/**
 * div_scan.py START. One position at a time makes the open trade path
 * dependent, so the scan runs over all the SIP history (2016+), like a
 * TradingView chart running the strategy over full history.
 */
export const DIV_START = "2016-01-01";

/** divergence-buy.pine `strategy(...)` sizing. */
export const DIV_STRATEGY_DEFAULTS = {
  /** initial_capital=10000 */
  initialCapital: 10000,
  /** default_qty_type=strategy.percent_of_equity, default_qty_value=10 */
  positionPct: 10,
  /** commission_type=strategy.commission.percent, commission_value=0.1 (per fill) */
  commissionPct: 0.1,
} as const;

/** `strategy.entry("Long", strategy.long)` — the entry order id TradingView prints. */
export const DIV_ENTRY_ID = "Long";
/** `strategy.close("Long", comment="Time")` — the exit comment TradingView prints. */
export const DIV_EXIT_COMMENT = "Time";

export interface DivSignalOptions {
  divMin?: number;
  divWindow?: number;
  ibsMax?: number;
}

export interface DivSignals {
  /** Positive regular divergences on each bar. */
  divPos: number[];
  /** Rolling divWindow sum of divPos (NaN for the first divWindow - 1 bars). */
  divSum: number[];
  /** (C - L) / (H - L), 0.5 for a zero-range bar. */
  ibs: number[];
  /** divSum >= divMin and ibs <= ibsMax. */
  hit: boolean[];
}

/** The per-bar signal columns div_scan.scan builds. */
export function divSignals(dailyBars: readonly Bar[], opts: DivSignalOptions = {}): DivSignals {
  const divMin = opts.divMin ?? DIV_MIN;
  const divWindow = opts.divWindow ?? DIV_WINDOW;
  const ibsMax = opts.ibsMax ?? IBS_MAX;
  const { divPos } = regularDivergence(dailyBars);
  const divSum = rollingSum(divPos, divWindow);
  const ibs = dailyBars.map((b) => {
    const v = (b.close - b.low) / (b.high - b.low);
    return v !== v ? 0.5 : v;
  });
  const hit = divSum.map((s, i) => s >= divMin && ibs[i]! <= ibsMax);
  return { divPos, divSum, ibs, hit };
}

/** One trade of the replay: [signal, entry, exit] bar indices (entry/exit may be past the data). */
export type TradeLeg = [signal: number, entry: number, exit: number];

/**
 * Replay one position at a time over the signal bars (div_scan.last_trade,
 * keeping every trade). Entry fills at the open after the signal, exit at
 * the open holdBars later.
 */
export function tradeChain(hit: readonly boolean[], holdBars = HOLD_BARS): TradeLeg[] {
  const out: TradeLeg[] = [];
  let i = 0;
  while (i < hit.length) {
    if (hit[i]) {
      out.push([i, i + 1, i + 1 + holdBars]);
      i += 1 + holdBars;
    } else {
      i += 1;
    }
  }
  return out;
}

/** div_scan.last_trade: the latest [signal, entry, exit] or null. */
export function lastTrade(hit: readonly boolean[], holdBars = HOLD_BARS): TradeLeg | null {
  const chain = tradeChain(hit, holdBars);
  return chain[chain.length - 1] ?? null;
}

/** Python `round(x, nd)`: correctly rounded, exact ties to even. */
export function pyRound(x: number, nd: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const ax = Math.abs(x);
  // toFixed is exact on the binary value but breaks ties upward; detect an
  // exact tie from a long expansion and apply round-half-even instead.
  const long = ax.toFixed(Math.min(100, nd + 30));
  const dot = long.indexOf(".");
  const rest = long.slice(dot + 1 + nd);
  let out: string;
  if (/^50*$/.test(rest)) {
    const head = long.slice(0, dot + 1 + nd);
    const lastDigit = Number(nd === 0 ? head.slice(0, -1).slice(-1) : head.slice(-1));
    out = lastDigit % 2 === 0 ? head : ax.toFixed(nd);
  } else {
    out = ax.toFixed(nd);
  }
  return x < 0 ? -Number(out) : Number(out);
}

/** div_scan.scan for one symbol; state null when flat. Throws with fewer than DIV_WINDOW bars. */
export function scanDivergence(symbol: string, dailyBars: readonly Bar[]): DivScanRow {
  const n = dailyBars.length;
  const sig = divSignals(dailyBars);
  const last = n - 1;
  const lastBar = dailyBars[last];
  const divSum = sig.divSum[last];
  if (!lastBar || divSum === undefined || divSum !== divSum) {
    throw new Error(`${symbol}: need at least ${DIV_WINDOW} daily bars, got ${n}`);
  }
  const price = lastBar.close;
  const row: DivScanRow = {
    symbol,
    lastBar: lastBar.time,
    price,
    divNow: sig.divPos[last]!,
    divSum,
    ibs: pyRound(sig.ibs[last]!, 2),
    state: null,
    signalDate: null,
    entryDate: null,
    entry: null,
    held: null,
    left: null,
    pnlPct: null,
  };
  const tr = lastTrade(sig.hit);
  if (tr === null || tr[2] <= last) return row; // never signalled, or trade closed

  const [s, e, x] = tr;
  row.signalDate = dailyBars[s]!.time;
  row.left = x - last;
  if (e > last) {
    row.state = "NEW"; // signal on the latest bar
  } else {
    const entry = dailyBars[e]!.open;
    row.state = x === last + 1 ? "EXIT" : "HOLD";
    row.entryDate = dailyBars[e]!.time;
    row.entry = entry;
    row.held = last - e + 1;
    row.pnlPct = (price / entry - 1) * 100;
  }
  return row;
}

// ── strategy tester ───────────────────────────────────────

export interface DivStrategyOptions extends DivSignalOptions {
  holdBars?: number;
  initialCapital?: number;
  /** % of equity per entry (pine default_qty_value). */
  positionPct?: number;
  /** % commission per fill (pine commission_value). */
  commissionPct?: number;
}

/**
 * Whole shares for a percent_of_equity order: TradingView sizes it from the
 * equity and the close of the bar the order is placed on (the signal bar).
 */
function sizeQty(equity: number, positionPct: number, price: number): number {
  const qty = Math.floor((equity * positionPct) / 100 / price);
  return qty > 0 ? qty : 0;
}

/**
 * Full-history replay of divergence-buy.pine as TradingView's strategy
 * tester shows it: one position at a time, next-open fills, exit at the open
 * holdBars after entry (the last trade may still be open; a signal on the
 * latest bar has not filled yet and is not listed). Sized with the pine's
 * percent-of-equity rule and commission.
 */
export function divergenceStrategy(dailyBars: readonly Bar[], opts: DivStrategyOptions = {}): StrategyResult {
  const holdBars = opts.holdBars ?? HOLD_BARS;
  const initialCapital = opts.initialCapital ?? DIV_STRATEGY_DEFAULTS.initialCapital;
  const positionPct = opts.positionPct ?? DIV_STRATEGY_DEFAULTS.positionPct;
  const fee = (opts.commissionPct ?? DIV_STRATEGY_DEFAULTS.commissionPct) / 100;
  const n = dailyBars.length;
  if (n === 0) return { trades: [], stats: computeStats(dailyBars, [], [], initialCapital, fee), markers: [] };

  const sig = divSignals(dailyBars, opts);
  const last = n - 1;
  const trades: StrategyTrade[] = [];
  const legs: TradeLeg[] = [];
  let equity = initialCapital;

  for (const leg of tradeChain(sig.hit, holdBars)) {
    const [s, e, x] = leg;
    if (e > last) break; // fills at the next open, not yet
    const qty = sizeQty(equity, positionPct, dailyBars[s]!.close);
    const entryPrice = dailyBars[e]!.open;
    const closed = x <= last;
    const exitPrice = closed ? dailyBars[x]!.open : null;
    const markPrice = exitPrice ?? dailyBars[last]!.close;

    let pnl: number;
    let pnlPct: number;
    if (closed) {
      pnl = qty * (markPrice - entryPrice) - fee * qty * entryPrice - fee * qty * markPrice;
      pnlPct = ((markPrice - entryPrice - fee * entryPrice - fee * markPrice) / entryPrice) * 100;
    } else {
      pnl = qty * (markPrice - entryPrice) - fee * qty * entryPrice;
      pnlPct = ((markPrice - entryPrice - fee * entryPrice) / entryPrice) * 100;
    }

    const endIdx = closed ? x - 1 : last;
    let hi = closed ? markPrice : -Infinity;
    let lo = closed ? markPrice : Infinity;
    for (let j = e; j <= endIdx; j++) {
      hi = Math.max(hi, dailyBars[j]!.high);
      lo = Math.min(lo, dailyBars[j]!.low);
    }

    trades.push({
      id: trades.length + 1,
      signalTime: dailyBars[s]!.time,
      entryTime: dailyBars[e]!.time,
      entryPrice,
      exitTime: closed ? dailyBars[x]!.time : null,
      exitPrice,
      qty,
      markPrice,
      pnl,
      pnlPct,
      bars: (closed ? x : last) - e,
      runUpPct: Math.max(0, (hi / entryPrice - 1) * 100),
      drawdownPct: Math.min(0, (lo / entryPrice - 1) * 100),
      divSum: sig.divSum[s]!,
      open: !closed,
    });
    legs.push(leg);
    if (closed) equity += pnl;
  }

  return {
    trades,
    stats: computeStats(dailyBars, trades, legs, initialCapital, fee),
    markers: strategyMarkers(trades),
  };
}

/** TradingView labels: "Long +7" under the entry bar, "-7 Time" over the exit bar. */
function strategyMarkers(trades: readonly StrategyTrade[]): StrategyMarker[] {
  const out: StrategyMarker[] = [];
  for (const t of trades) {
    out.push({ time: t.entryTime, kind: "entry", label: t.qty > 0 ? `${DIV_ENTRY_ID} +${t.qty}` : DIV_ENTRY_ID });
    if (t.exitTime !== null) {
      out.push({ time: t.exitTime, kind: "exit", label: t.qty > 0 ? `-${t.qty} ${DIV_EXIT_COMMENT}` : DIV_EXIT_COMMENT });
    }
  }
  return out;
}

function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * Strategy-tester summary over closed trades. Winners / losers are split by
 * the trade's net %; drawdown is peak-to-trough of the equity marked at each
 * bar's close (open P/L net of the entry commission).
 */
function computeStats(
  bars: readonly Bar[],
  trades: readonly StrategyTrade[],
  legs: readonly TradeLeg[],
  initialCapital: number,
  fee: number,
): StrategyStats {
  const closed = trades.filter((t) => !t.open);
  const wins = closed.filter((t) => t.pnlPct > 0);
  const losses = closed.filter((t) => t.pnlPct < 0);
  const netProfit = closed.reduce((a, t) => a + t.pnl, 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);

  const equity: StrategyStats["equity"] = [];
  if (bars.length) equity.push({ time: bars[0]!.time, value: initialCapital });
  let eq = initialCapital;
  for (const t of closed) {
    eq += t.pnl;
    equity.push({ time: t.exitTime!, value: eq });
  }

  // mark-to-market drawdown
  let closedEq = initialCapital;
  let peak = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let k = 0;
  for (let j = 0; j < bars.length; j++) {
    while (k < trades.length && !trades[k]!.open && legs[k]![2] <= j) {
      closedEq += trades[k]!.pnl;
      k += 1;
    }
    let value = closedEq;
    const t = trades[k];
    if (t && legs[k]![1] <= j) {
      value += t.qty * (bars[j]!.close - t.entryPrice) - fee * t.qty * t.entryPrice;
    }
    if (value > peak) peak = value;
    const dd = peak - value;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPct = (dd / peak) * 100;
    }
  }

  const first = bars[0];
  const lastBar = bars[bars.length - 1];
  return {
    initialCapital,
    netProfit,
    netProfitPct: (netProfit / initialCapital) * 100,
    grossProfit,
    grossLoss,
    profitFactor: closed.length === 0 ? 0 : losses.length === 0 ? Infinity : grossProfit / grossLoss,
    closedTrades: closed.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    avgTradePct: mean(closed.map((t) => t.pnlPct)),
    avgWinPct: mean(wins.map((t) => t.pnlPct)),
    avgLossPct: mean(losses.map((t) => t.pnlPct)),
    avgBars: mean(closed.map((t) => t.bars)),
    maxDrawdown,
    maxDrawdownPct,
    buyHoldPct: first && lastBar ? (lastBar.close / first.close - 1) * 100 : 0,
    equity,
  };
}

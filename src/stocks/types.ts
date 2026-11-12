/**
 * Shared contract for the stock workspace (VITE_ADAPTER=alpaca).
 *
 * Three layers meet here:
 *   - src/stocks/scans/  pure TypeScript ports of trading-script's Python scans
 *                        (div_scan.py, stoch_scan.py, backtest/indicators.py).
 *                        Run both in the browser (chart overlays, strategy
 *                        tester) and in the dev server (the 150-symbol scans).
 *   - src/stocks/data/   the Alpaca client, the OpenCharts adapter, holdings.
 *   - src/stocks/server/ the Vite dev-server plugin: Alpaca proxy (keys stay
 *                        server-side), bar cache, list.txt / journal.json, scans.
 *   - src/stocks/ui/     the workspace layout.
 *
 * Every timestamp is unix SECONDS of the bar's open as Alpaca reports it (daily
 * bars open at 00:00 America/New_York, i.e. 04:00 or 05:00 UTC).
 */

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** One line of trading-script/list.txt, e.g. "NASDAQ:AAL". */
export interface ListEntry {
  exchange: string;
  symbol: string;
}

// ── Divergence Buy (div_scan.py) ──────────────────────────

export type DivState = "NEW" | "HOLD" | "EXIT";

export interface DivScanRow {
  symbol: string;
  /** Latest daily bar time. */
  lastBar: number;
  price: number;
  /** Positive regular divergences on the latest bar. */
  divNow: number;
  /** Rolling DIV_WINDOW sum on the latest bar. */
  divSum: number;
  /** Internal bar strength of the latest bar, rounded to 2 decimals. */
  ibs: number;
  /** null = flat (no open trade, no fresh signal). */
  state: DivState | null;
  signalDate: number | null;
  entryDate: number | null;
  entry: number | null;
  /** Bars held, entry bar included. */
  held: number | null;
  /** Opens left until the sell open. */
  left: number | null;
  pnlPct: number | null;
}

// ── Stoch RSI 4-cross (stoch_scan.py) ─────────────────────

export type StochStage = "ARMED" | "CONFIRMED" | "FAILED";

export interface StochScanRow {
  symbol: string;
  interval: "1w";
  lastBar: number;
  price: number;
  stage: StochStage | null;
  signalDate: number | null;
  daysSince: number | null;
  entry: number | null;
  sl: number | null;
  tp: number | null;
  /** Signal within MAX_DAYS of the last closed bar. */
  fresh: boolean;
  /** Interpolated K/D values of the four crosses, oldest first. */
  crosses: [number, number, number, number] | null;
  /** Bars between consecutive crosses. */
  gaps: [number, number, number] | null;
  nEvents: number;
}

// ── Chart overlays ────────────────────────────────────────

/** One regular divergence: price pivot vs oscillator pivot disagree. */
export interface Divergence {
  kind: "bull" | "bear";
  /** Bar where the divergence is confirmed (the later pivot + prd bars). */
  time: number;
  /** Price pivots the divergence line connects. */
  fromTime: number;
  fromPrice: number;
  toTime: number;
  toPrice: number;
  /** Oscillators that agree, e.g. ["macd", "rsi", "obv"]. */
  indicators: string[];
}

/** A strategy marker on the price chart (TradingView-style "Long" / exit labels). */
export interface StrategyMarker {
  time: number;
  kind: "entry" | "exit";
  /** Short label, e.g. "Long +7" or "Time -3.2%". */
  label: string;
}

// ── Strategy tester ───────────────────────────────────────

export interface StrategyTrade {
  /** 1-based, in entry order. */
  id: number;
  signalTime: number;
  entryTime: number;
  entryPrice: number;
  /** null while the trade is still open. */
  exitTime: number | null;
  exitPrice: number | null;
  /** Shares bought with the strategy's sizing rule. */
  qty: number;
  /** Close of the last bar for open trades, else exit price. */
  markPrice: number;
  pnl: number;
  pnlPct: number;
  /** Bars from entry to exit (or to the last bar while open). */
  bars: number;
  /** Highest / lowest unrealized % while in the trade. */
  runUpPct: number;
  drawdownPct: number;
  /** Divergence sum on the signal bar. */
  divSum: number;
  open: boolean;
}

export interface StrategyStats {
  initialCapital: number;
  netProfit: number;
  netProfitPct: number;
  grossProfit: number;
  grossLoss: number;
  /** Infinity when there are no losing trades. */
  profitFactor: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  /** 0..1 */
  winRate: number;
  avgTradePct: number;
  avgWinPct: number;
  avgLossPct: number;
  avgBars: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  buyHoldPct: number;
  /** Closed-trade equity after each exit, plus a starting point. */
  equity: { time: number; value: number }[];
}

export interface StrategyResult {
  trades: StrategyTrade[];
  stats: StrategyStats;
  markers: StrategyMarker[];
}

// ── Scans endpoint ────────────────────────────────────────

export interface ScanFailure {
  symbol: string;
  scan: "div" | "stoch";
  error: string;
}

export interface ScanReport {
  /** ISO time the scan ran. */
  generatedAt: string;
  /** Latest daily bar across the universe. */
  asOf: number | null;
  universe: ListEntry[];
  div: DivScanRow[];
  stoch: StochScanRow[];
  failures: ScanFailure[];
}

// ── Market snapshot (watchlist + details card) ────────────

export interface StockSnapshot {
  symbol: string;
  last: number | null;
  /** Epoch ms of the last trade. */
  lastTime: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  /** Today's consolidated volume (15-min delayed on the free plan). */
  volume: number | null;
  avgVolume30: number | null;
  bid: number | null;
  ask: number | null;
  /** Outside 09:30–16:00 ET: last extended-hours trade, if any. */
  extended: {
    price: number;
    change: number;
    changePct: number;
    session: "pre" | "post";
    /** Epoch ms of that trade. */
    time?: number;
  } | null;
}

export interface AssetInfo {
  symbol: string;
  name: string;
  exchange: string;
  tradable: boolean;
}

// ── Holdings (trading-script/dashboard/data/journal.json) ─

export interface Holding {
  symbol: string;
  shares: number;
  /** Average cost per share; null when no fill carried a price. */
  avgPrice: number | null;
  cost: number;
  /** Earliest open-lot day, YYYY-MM-DD. */
  since: string;
  buys: number;
  /** Some fills lack qty or price, so $ P/L covers only part of the position. */
  partial: boolean;
}

export interface ClosedTrade {
  symbol: string;
  openedOn: string;
  closedOn: string;
  shares: number;
  avgEntry: number | null;
  avgExit: number | null;
  realized: number | null;
  realizedPct: number | null;
}

export interface HoldingsReport {
  open: Holding[];
  closed: ClosedTrade[];
  /** Journal lines the parser could not use. */
  warnings: string[];
}

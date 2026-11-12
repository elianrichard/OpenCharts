/**
 * Stock scans: pure TypeScript ports of trading-script's Python scans
 * (backtest/indicators.py, railway/div_scan.py, railway/stoch_scan.py).
 * No DOM, fetch or Node APIs — safe in the browser and in a Vite plugin.
 */
export {
  atr,
  barColumns,
  cci,
  cmf,
  ema,
  ewmMean,
  macdAll,
  mfi,
  momentum,
  obv,
  rma,
  rollingMax,
  rollingMean,
  rollingMin,
  rollingSum,
  rsi,
  stochK,
  stochRsi,
  vwma,
  vwmacd,
} from "./indicators.ts";
export type { BarColumns } from "./indicators.ts";

export {
  DIV_INDICATORS,
  DIV_INDICATOR_LABELS,
  analyzeDivergences,
  divergenceSeries,
  listDivergences,
  regularDivergence,
} from "./divergence.ts";
export type { DivIndicator, DivergenceAnalysis, ListDivergenceOptions } from "./divergence.ts";

export {
  DIV_ENTRY_ID,
  DIV_EXIT_COMMENT,
  DIV_MIN,
  DIV_START,
  DIV_STRATEGY_DEFAULTS,
  DIV_WINDOW,
  HOLD_BARS,
  IBS_MAX,
  divSignals,
  divergenceStrategy,
  lastTrade,
  pyRound,
  scanDivergence,
  tradeChain,
} from "./divScan.ts";
export type { DivSignalOptions, DivSignals, DivStrategyOptions, TradeLeg } from "./divScan.ts";

export {
  ATR_LEN,
  CONFIRM_BARS,
  CONFIRM_KD_GAP,
  LVL1,
  LVL2,
  LVL4,
  MAX_GAP,
  MIN_GAP,
  MIN_SEP,
  RSI_LEN,
  SL_MULT,
  SMOOTH_D,
  SMOOTH_K,
  STOCH_ARMED_LABEL,
  STOCH_CONFIRMED_LABEL,
  STOCH_INTERVALS,
  STOCH_LEN,
  STOCH_MAX_DAYS,
  STOCH_STARTS,
  TOL,
  TP_MULT,
  detectStochEvents,
  dropForming,
  scanStoch,
  scanStochRsi,
  stochStrategyMarkers,
} from "./stochScan.ts";
export type { StochEvent } from "./stochScan.ts";

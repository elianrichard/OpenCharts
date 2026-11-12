import type { Timeframe } from "../../../pages/trading/constants.ts";

/** Interval labels as TradingView prints them. */
export const TF_LABEL: Record<Timeframe, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "4h": "4h",
  "1d": "D",
  "1w": "W",
};

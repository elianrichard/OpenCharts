import type { CandlestickData, Time } from "lightweight-charts";

/** Heikin Ashi bars from real OHLC, oldest first. */
export function toHeikinAshi(rows: CandlestickData<Time>[]): CandlestickData<Time>[] {
  const out: CandlestickData<Time>[] = [];
  for (let i = 0; i < rows.length; i++) {
    out.push(heikinAshiBar(rows[i]!, out[i - 1]));
  }
  return out;
}

export function heikinAshiBar(
  bar: CandlestickData<Time>,
  prevHa: CandlestickData<Time> | undefined,
): CandlestickData<Time> {
  const close = (bar.open + bar.high + bar.low + bar.close) / 4;
  const open = prevHa ? (prevHa.open + prevHa.close) / 2 : (bar.open + bar.close) / 2;
  return {
    time: bar.time,
    open,
    high: Math.max(bar.high, open, close),
    low: Math.min(bar.low, open, close),
    close,
  };
}

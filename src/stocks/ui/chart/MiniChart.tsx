import { useQuery } from "@tanstack/react-query";
import {
  ColorType,
  CrosshairMode,
  createChart,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { Maximize2, Search } from "lucide-react";
import { useEffect, useRef } from "react";
import { ema } from "../../../lib/indicators.ts";
import type { Timeframe } from "../../../pages/trading/constants.ts";
import { fmtPct, fmtPrice, polarity } from "../format.ts";
import { useSnapshot } from "../market.ts";
import { fetchBars } from "../queries.ts";
import { MINI_PALETTE } from "./palette.ts";
import { EMA_RIBBON } from "./useStockOverlays.ts";

/**
 * A secondary chart cell for the 2- and 4-chart layouts: candles, volume and
 * the EMA ribbon on the main chart's interval. Drawing, markers and the
 * strategy tester stay on the main chart; "Make main" swaps this symbol in.
 */

export function MiniChart({
  symbol,
  timeframe,
  onChangeSymbol,
  onMakeMain,
}: {
  symbol: string;
  timeframe: Timeframe;
  onChangeSymbol: () => void;
  onMakeMain: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ribbonRef = useRef<ISeriesApi<"Line">[]>([]);
  const snap = useSnapshot(symbol);
  const bars = useQuery({
    queryKey: ["stocks", "mini", symbol, timeframe],
    queryFn: () => fetchBars(symbol, timeframe, 600),
    enabled: !!symbol,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: MINI_PALETTE.background },
        textColor: MINI_PALETTE.text,
        fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: MINI_PALETTE.grid, style: LineStyle.Dotted },
        horzLines: { color: MINI_PALETTE.grid, style: LineStyle.Dotted },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: MINI_PALETTE.grid, scaleMargins: { top: 0.08, bottom: 0.2 } },
      timeScale: { borderColor: MINI_PALETTE.grid, rightOffset: 4 },
    });
    candlesRef.current = chart.addCandlestickSeries({
      upColor: MINI_PALETTE.up,
      downColor: MINI_PALETTE.down,
      borderUpColor: MINI_PALETTE.up,
      borderDownColor: MINI_PALETTE.down,
      wickUpColor: MINI_PALETTE.up,
      wickDownColor: MINI_PALETTE.down,
    });
    volumeRef.current = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    ribbonRef.current = EMA_RIBBON.map((e) =>
      chart.addLineSeries({
        color: e.color,
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      }),
    );
    chartRef.current = chart;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candlesRef.current = null;
      volumeRef.current = null;
      ribbonRef.current = [];
    };
  }, []);

  useEffect(() => {
    const data = bars.data;
    if (!data || !candlesRef.current) return;
    candlesRef.current.setData(data.map((b) => ({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close })));
    volumeRef.current?.setData(
      data.map((b) => ({
        time: b.time as Time,
        value: b.volume,
        color: b.close >= b.open ? "rgba(68,162,130,0.25)" : "rgba(229,86,111,0.25)",
      })),
    );
    EMA_RIBBON.forEach((e, i) => {
      ribbonRef.current[i]?.setData(ema(data, e.length).map((p) => ({ time: p.time as Time, value: p.value })));
    });
    chartRef.current?.timeScale().scrollToRealTime();
  }, [bars.data]);

  // Fold the latest trade into the last bar between refetches.
  useEffect(() => {
    const data = bars.data;
    const last = data?.[data.length - 1];
    if (!last || snap?.last == null || !candlesRef.current) return;
    try {
      candlesRef.current.update({
        time: last.time as Time,
        open: last.open,
        high: Math.max(last.high, snap.last),
        low: Math.min(last.low, snap.last),
        close: snap.last,
      });
    } catch {
      /* out of order */
    }
  }, [snap?.last, bars.data]);

  const pol = polarity(snap?.changePct);
  return (
    <div className="relative flex min-h-0 min-w-0 flex-col bg-[var(--surface)]">
      <div className="absolute left-2 top-1.5 z-10 flex items-center gap-2 text-[12px]">
        <button type="button" className="tbtn !h-6 !px-1.5 font-semibold !text-[var(--ink)]" onClick={onChangeSymbol} aria-label={`Change symbol in this cell (${symbol})`}>
          <Search className="h-3 w-3 text-[var(--mute)]" />
          {symbol}
        </button>
        <span className="num">{fmtPrice(snap?.last)}</span>
        <span className="num" style={{ color: pol > 0 ? "var(--pos)" : pol < 0 ? "var(--neg)" : "var(--ink-2)" }}>
          {fmtPct(snap?.changePct)}
        </span>
      </div>
      <button
        type="button"
        className="tbtn absolute right-16 top-1.5 z-10 !h-6 !px-1.5"
        onClick={onMakeMain}
        title="Make this the main chart"
        aria-label={`Make ${symbol} the main chart`}
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
      <div ref={box} className="min-h-0 flex-1" />
      {bars.isError && (
        <p className="absolute inset-x-0 top-1/2 text-center text-[12px] text-[var(--mute)]">No bars for {symbol}.</p>
      )}
    </div>
  );
}

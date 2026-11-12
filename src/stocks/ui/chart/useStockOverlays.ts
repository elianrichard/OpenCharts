import {
  LineStyle,
  PriceScaleMode,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { ema } from "../../../lib/indicators.ts";
import type { IndicatorType } from "../../../lib/indicators.ts";
import type { ChartApiHandle, ChartBar } from "../../../pages/trading/ChartPanel.tsx";
import type { Timeframe } from "../../../pages/trading/constants.ts";
import { listDivergences, STOCH_CONFIRMED_LABEL, stochRsi } from "../../scans/index.ts";
import type { Bar, StrategyMarker } from "../../types.ts";
import type { OverlayId } from "../store.ts";
import { DivergenceLines } from "./divergenceLines.ts";
import { layoutPanes, type PaneLayout } from "./paneLayout.ts";

/**
 * Everything the stock workspace draws on top of the shared ChartPanel:
 * the EMA ribbon, the Stoch RSI pane, regular-divergence lines, Divergence
 * Buy / Stoch 4-cross markers and compare lines, plus the pane stacking for
 * every oscillator (built-in RSI/MACD/ATR/Stoch included).
 *
 * It owns only the series it creates and removes them on teardown, so the
 * ChartPanel's own series, drawings and price lines are never touched.
 */

export const EMA_RIBBON = [
  { length: 20, color: "#b9d2f1" },
  { length: 50, color: "#86b0e6" },
  { length: 100, color: "#4a8ad6" },
  { length: 200, color: "#2f5f9c" },
] as const;

export const STOCH_RSI = { rsiLen: 14, stochLen: 14, smoothK: 5, smoothD: 5 } as const;
const STOCH_K_COLOR = "#4a8ad6";
const STOCH_D_COLOR = "#d9a441";

/** Oscillators that must agree before a divergence is drawn. */
export const MIN_AGREEING = 2;

export const COMPARE_COLORS = ["#d9a441", "#bdbdc0", "#5fc39c", "#e5566f"] as const;

/** Oscillators that get their own pane, in stacking order (top first). */
const BUILTIN_PANES: { type: IndicatorType; scaleId: string; title: string }[] = [
  { type: "RSI", scaleId: "rsi", title: "RSI 14" },
  { type: "MACD", scaleId: "macd", title: "MACD 12 26 9" },
  { type: "STOCH", scaleId: "stoch", title: "Stoch 14 3" },
  { type: "ATR", scaleId: "atr", title: "ATR 14" },
];

export interface PaneInfo {
  scaleId: string;
  title: string;
  /** Live readouts for the legend, e.g. [["K", "45.12", color]]. */
  values: { label: string; value: string; color: string }[];
}

export interface OverlayLegendItem {
  id: OverlayId | "compare";
  title: string;
  detail?: string;
  values: { label: string; value: string; color: string }[];
  /** Shown but not drawn on this timeframe (e.g. a daily-only strategy). */
  inactiveReason?: string;
}

export interface CompareSeries {
  symbol: string;
  bars: Bar[];
}

interface Params {
  api: ChartApiHandle | null;
  bars: ChartBar[];
  timeframe: Timeframe;
  overlays: Record<OverlayId, boolean>;
  activeIndicators: IndicatorType[];
  volumeVisible: boolean;
  /** Divergence Buy markers from the full daily history (null while loading). */
  divMarkers: StrategyMarker[] | null;
  /** Stoch 4-cross markers from the full weekly history. */
  stochMarkers: StrategyMarker[] | null;
  compare: CompareSeries[];
  /** Pixels at the top of the chart the legend covers. */
  legendPx: number;
}

/** The price-axis strip of one oscillator pane, drawn over the main axis. */
export interface PaneAxis {
  scaleId: string;
  top: number;
  height: number;
  ticks: { y: number; label: string }[];
}

export interface StockOverlays {
  markers: SeriesMarker<Time>[];
  layout: PaneLayout;
  panes: PaneInfo[];
  legend: OverlayLegendItem[];
  /** Height of the price area (chart minus time axis), for pane separators. */
  priceAreaHeight: number;
  /** Width of the right price axis, for the pane axis strips. */
  axisWidth: number;
  paneAxes: PaneAxis[];
}

const fmt2 = (v: number | undefined) => (v == null || !Number.isFinite(v) ? "–" : v.toFixed(2));

function lineOpts(color: string, priceScaleId: string, width: 1 | 2 = 1) {
  return {
    color,
    lineWidth: width,
    priceScaleId,
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  } as const;
}

function safeRemove(api: ChartApiHandle, series: ISeriesApi<"Line">[]) {
  for (const s of series) {
    try {
      api.chart.removeSeries(s);
    } catch {
      /* chart already gone */
    }
  }
}

function toMarkers(
  items: StrategyMarker[] | null,
  times: Set<number>,
  style: "div" | "stoch",
): SeriesMarker<Time>[] {
  if (!items) return [];
  const out: SeriesMarker<Time>[] = [];
  for (const m of items) {
    if (!times.has(m.time)) continue;
    const entry = m.kind === "entry";
    if (style === "stoch") {
      // The pine's own texts: "P" when the pattern arms, "4X" when it confirms.
      const confirmed = m.label === STOCH_CONFIRMED_LABEL;
      out.push({
        time: m.time as Time,
        position: "belowBar",
        shape: confirmed ? "arrowUp" : "circle",
        color: confirmed ? "#4a8ad6" : "#d9a441",
        text: m.label,
        size: 1,
      });
      continue;
    }
    out.push({
      time: m.time as Time,
      position: entry ? "belowBar" : "aboveBar",
      shape: entry ? "arrowUp" : "arrowDown",
      color: entry ? "#4a8ad6" : "#bdbdc0",
      text: m.label,
      size: 1,
    });
  }
  return out;
}

export function useStockOverlays({
  api,
  bars,
  timeframe,
  overlays,
  activeIndicators,
  volumeVisible,
  divMarkers,
  stochMarkers,
  compare,
  legendPx,
}: Params): StockOverlays {
  const comparing = compare.length > 0;
  const showRibbon = overlays.emaRibbon && !comparing;

  // ── Indicator math (pure, memoised on the bars) ──
  const ribbon = useMemo(
    () => (showRibbon && bars.length > 0 ? EMA_RIBBON.map((e) => ema(bars, e.length)) : null),
    [showRibbon, bars],
  );
  const stoch = useMemo(() => {
    if (!overlays.stochRsi || bars.length === 0) return null;
    const { k, d } = stochRsi(
      bars.map((b) => b.close),
      STOCH_RSI.rsiLen,
      STOCH_RSI.stochLen,
      STOCH_RSI.smoothK,
      STOCH_RSI.smoothD,
    );
    const toPts = (arr: number[]) =>
      arr.flatMap((v, i) => (Number.isFinite(v) ? [{ time: bars[i]!.time as Time, value: v }] : []));
    return { k: toPts(k), d: toPts(d) };
  }, [overlays.stochRsi, bars]);
  const divergences = useMemo(
    // collapse: a newer divergence before the next pivot replaces the drawing, as in the pine.
    // Two or more agreeing oscillators: one-indicator divergences are mostly noise
    // and drown the chart (the scan itself needs three in four bars).
    () =>
      overlays.divLines && bars.length > 30
        ? listDivergences(bars, 5, 10, 100, { collapse: true }).filter((d) => d.indicators.length >= MIN_AGREEING)
        : [],
    [overlays.divLines, bars],
  );

  // ── Price-area height (pane separators, legend clearance) ──
  const [priceAreaHeight, setPriceAreaHeight] = useState(0);
  useEffect(() => {
    if (!api) return;
    const measure = () => {
      const h = api.container.clientHeight - api.chart.timeScale().height();
      setPriceAreaHeight(h > 0 ? h : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(api.container);
    return () => ro.disconnect();
  }, [api]);

  // ── Pane layout ──
  const paneDefs = useMemo(() => {
    const defs: { scaleId: string; title: string }[] = [];
    if (overlays.stochRsi) {
      defs.push({
        scaleId: "stochrsi",
        title: `Stoch RSI ${STOCH_RSI.rsiLen} ${STOCH_RSI.stochLen} ${STOCH_RSI.smoothK} ${STOCH_RSI.smoothD}`,
      });
    }
    for (const p of BUILTIN_PANES) if (activeIndicators.includes(p.type)) defs.push(p);
    return defs;
  }, [overlays.stochRsi, activeIndicators]);
  const topFraction =
    priceAreaHeight > 0 ? Math.min(0.3, Math.max(0.06, (legendPx + 8) / priceAreaHeight)) : 0.06;
  const layout = useMemo(
    () => layoutPanes(
      paneDefs.map((p) => p.scaleId),
      volumeVisible,
      topFraction,
    ),
    [paneDefs, volumeVisible, topFraction],
  );

  // ── Series lifecycle ──
  const ribbonRef = useRef<ISeriesApi<"Line">[]>([]);
  const stochRef = useRef<ISeriesApi<"Line">[]>([]);
  const compareRef = useRef<ISeriesApi<"Line">[]>([]);
  const divRef = useRef<DivergenceLines | null>(null);

  useEffect(() => {
    if (!api || !ribbon) return;
    const created = EMA_RIBBON.map((e, i) => {
      const s = api.chart.addLineSeries(lineOpts(e.color, "right"));
      s.setData(ribbon[i]!.map((p) => ({ time: p.time as Time, value: p.value })));
      return s;
    });
    ribbonRef.current = created;
    return () => {
      ribbonRef.current = [];
      safeRemove(api, created);
    };
  }, [api, ribbon]);

  useEffect(() => {
    if (!api || !stoch) return;
    // A bounded oscillator keeps a fixed 0–100 scale, so its levels never move.
    const fixed = { autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) };
    const k = api.chart.addLineSeries({ ...lineOpts(STOCH_K_COLOR, "stochrsi"), ...fixed });
    const d = api.chart.addLineSeries({ ...lineOpts(STOCH_D_COLOR, "stochrsi"), ...fixed });
    k.setData(stoch.k);
    d.setData(stoch.d);
    for (const level of [80, 20]) {
      k.createPriceLine({
        price: level,
        color: "#3a3a3e",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: "",
      });
    }
    stochRef.current = [k, d];
    return () => {
      stochRef.current = [];
      safeRemove(api, [k, d]);
    };
  }, [api, stoch]);

  // Volume's own last-value label would sit on the pane axes.
  useEffect(() => {
    api?.volume.applyOptions({ lastValueVisible: false, priceLineVisible: false });
  }, [api]);

  useEffect(() => {
    if (!api) return;
    const prim = new DivergenceLines({
      bull: "rgba(95,195,156,0.8)",
      bear: "rgba(229,86,111,0.8)",
      labelInk: "#ffffff",
      labelBg: "rgba(33,32,35,0.92)",
    });
    api.series.attachPrimitive(prim);
    divRef.current = prim;
    return () => {
      divRef.current = null;
      try {
        api.series.detachPrimitive(prim);
      } catch {
        /* chart already gone */
      }
    };
  }, [api]);
  useEffect(() => {
    divRef.current?.setData(divergences, true);
  }, [divergences, api]);

  // Compare lines share the right scale, which switches to percent so every
  // symbol starts at 0% on the first visible bar (TradingView's compare mode).
  useEffect(() => {
    if (!api || compare.length === 0) return;
    const created = compare.map((c, i) => {
      const s = api.chart.addLineSeries({
        ...lineOpts(COMPARE_COLORS[i % COMPARE_COLORS.length]!, "right", 2),
        lastValueVisible: true,
        title: c.symbol,
      });
      s.setData(c.bars.map((b) => ({ time: b.time as Time, value: b.close })));
      return s;
    });
    compareRef.current = created;
    try {
      api.chart.priceScale("right").applyOptions({ mode: PriceScaleMode.Percentage });
    } catch {
      /* scale not ready */
    }
    return () => {
      compareRef.current = [];
      try {
        api.chart.priceScale("right").applyOptions({ mode: PriceScaleMode.Normal });
      } catch {
        /* chart already gone */
      }
      safeRemove(api, created);
    };
  }, [api, compare]);

  // Apply the stacking after every change that can create or reset a scale.
  useEffect(() => {
    if (!api) return;
    const apply = (id: string, margins: { top: number; bottom: number }) => {
      try {
        api.chart.priceScale(id).applyOptions({ scaleMargins: margins, borderVisible: false });
      } catch {
        /* that pane's series is not on the chart yet */
      }
    };
    apply("right", layout.main);
    apply("volume", layout.volume);
    for (const p of layout.panes) apply(p.scaleId, p.margins);
  }, [api, layout, stoch, activeIndicators, bars]);

  // ── Crosshair readouts (falls back to the last bar) ──
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const indexByTime = useMemo(() => {
    const m = new Map<number, number>();
    bars.forEach((b, i) => m.set(b.time, i));
    return m;
  }, [bars]);
  useEffect(() => {
    if (!api) return;
    let frame = 0;
    const handler = (param: { time?: Time }) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const t = param.time as number | undefined;
        setHoverIndex(t == null ? null : (indexByTime.get(t) ?? null));
      });
    };
    api.chart.subscribeCrosshairMove(handler);
    return () => {
      cancelAnimationFrame(frame);
      api.chart.unsubscribeCrosshairMove(handler);
    };
  }, [api, indexByTime]);
  const at = hoverIndex ?? bars.length - 1;
  const atTime = bars[at]?.time;

  const valueAt = (pts: { time: Time | number; value: number }[] | undefined) => {
    if (!pts || atTime == null) return undefined;
    // Points skip the warmup, so search from the end (cheap for the last bar).
    for (let i = pts.length - 1; i >= 0; i--) {
      const t = pts[i]!.time as number;
      if (t === atTime) return pts[i]!.value;
      if (t < atTime) return undefined;
    }
    return undefined;
  };

  const panes: PaneInfo[] = paneDefs.map((p) => ({
    scaleId: p.scaleId,
    title: p.title,
    values:
      p.scaleId === "stochrsi" && stoch
        ? [
            { label: "K", value: fmt2(valueAt(stoch.k)), color: STOCH_K_COLOR },
            { label: "D", value: fmt2(valueAt(stoch.d)), color: STOCH_D_COLOR },
          ]
        : [],
  }));

  const times = useMemo(() => new Set(bars.map((b) => b.time)), [bars]);
  const markers = useMemo(() => {
    const out: SeriesMarker<Time>[] = [];
    if (overlays.divBuy && timeframe === "1d") out.push(...toMarkers(divMarkers, times, "div"));
    if (overlays.stoch4x && timeframe === "1w") out.push(...toMarkers(stochMarkers, times, "stoch"));
    return out;
  }, [overlays.divBuy, overlays.stoch4x, timeframe, divMarkers, stochMarkers, times]);

  const legend: OverlayLegendItem[] = [];
  if (overlays.emaRibbon) {
    legend.push({
      id: "emaRibbon",
      title: "EMA ribbon",
      detail: EMA_RIBBON.map((e) => e.length).join(" "),
      values: comparing
        ? []
        : EMA_RIBBON.map((e, i) => ({
            label: String(e.length),
            value: fmt2(valueAt(ribbon?.[i])),
            color: e.color,
          })),
      inactiveReason: comparing ? "hidden while comparing" : undefined,
    });
  }
  if (overlays.divBuy) {
    legend.push({
      id: "divBuy",
      title: "Divergence Buy",
      detail: "≥3 in 4 bars · IBS ≤ 0.25 · hold 20",
      values: [],
      inactiveReason: timeframe === "1d" ? undefined : "daily chart only",
    });
  }
  if (overlays.stoch4x) {
    legend.push({
      id: "stoch4x",
      title: "Stoch RSI 4-cross",
      detail: "ARM / CNF",
      values: [],
      inactiveReason: timeframe === "1w" ? undefined : "weekly chart only",
    });
  }
  if (overlays.divLines) {
    const shown = divergences.length;
    legend.push({
      id: "divLines",
      title: "Divergences",
      detail: `≥${MIN_AGREEING} of 10 oscillators · pivot 5`,
      values: [{ label: "", value: `${shown} on chart`, color: "#8a8c92" }],
    });
  }
  if (comparing) {
    legend.push({
      id: "compare",
      title: "Compare",
      detail: "% from first visible bar",
      values: compare.map((c, i) => ({
        label: c.symbol,
        value: "",
        color: COMPARE_COLORS[i % COMPARE_COLORS.length]!,
      })),
    });
  }

  // ── Pane axis strips: mask the main axis inside each pane and print the
  // pane's own levels (only the Stoch RSI series are ours to measure). ──
  const [axisWidth, setAxisWidth] = useState(0);
  const [stochTicks, setStochTicks] = useState<{ y: number; label: string }[]>([]);
  useEffect(() => {
    if (!api) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          setAxisWidth(api.chart.priceScale("right").width());
        } catch {
          /* chart gone */
        }
        const k = stochRef.current[0];
        if (!k) {
          setStochTicks([]);
          return;
        }
        const ticks = [80, 50, 20].flatMap((level) => {
          const y = k.priceToCoordinate(level);
          return y == null ? [] : [{ y, label: level.toFixed(2) }];
        });
        setStochTicks(ticks);
      });
    };
    measure();
    const ts = api.chart.timeScale();
    ts.subscribeVisibleLogicalRangeChange(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(api.container);
    return () => {
      cancelAnimationFrame(frame);
      ts.unsubscribeVisibleLogicalRangeChange(measure);
      ro.disconnect();
    };
  }, [api, stoch, layout, priceAreaHeight]);

  // The volume band sits under the price data, so the main axis would print
  // prices below the lowest bar there (negative ones on a long weekly chart).
  const volumeAxis: PaneAxis[] =
    volumeVisible && priceAreaHeight > 0
      ? [
          {
            scaleId: "volume",
            top: (1 - layout.main.bottom) * priceAreaHeight,
            height: (layout.main.bottom - layout.total) * priceAreaHeight,
            ticks: [],
          },
        ]
      : [];
  const paneAxes: PaneAxis[] = volumeAxis.concat(layout.panes.map((p) => {
    const top = p.start * priceAreaHeight;
    const height = (p.end - p.start) * priceAreaHeight;
    return {
      scaleId: p.scaleId,
      top,
      height,
      ticks:
        p.scaleId === "stochrsi"
          ? stochTicks.map((t) => ({ y: t.y - top, label: t.label })).filter((t) => t.y > 6 && t.y < height - 6)
          : [],
    };
  }));

  return { markers, layout, panes, legend, priceAreaHeight, axisWidth, paneAxes };
}

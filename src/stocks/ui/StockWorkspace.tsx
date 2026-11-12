import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  List,
  PanelBottomClose,
  PanelBottomOpen,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useChartPreferences } from "../../hooks/useChartPreferences.ts";
import { cn } from "../../lib/utils.ts";
import { ChartPanel, type ChartApiHandle, type ChartBar } from "../../pages/trading/ChartPanel.tsx";
import type { Timeframe } from "../../pages/trading/constants.ts";
import { wsClient } from "../../services/ws.ts";
import { toast } from "../../services/toast.ts";
import { useTerminal } from "../../terminal/use-terminal.ts";
import { divergenceStrategy, stochStrategyMarkers } from "../scans/index.ts";
import { useAlertEngine } from "./alerts/alertEngine.ts";
import { AlertDialog, AlertsList } from "./alerts/alerts.tsx";
import { DivBuyTable, HoldingsTable, ScanHeaderStatus, StochTable } from "./bottom/ScanTables.tsx";
import { StrategyTester } from "./bottom/StrategyTester.tsx";
import { MiniChart } from "./chart/MiniChart.tsx";
import { MINI_PALETTE } from "./chart/palette.ts";
import { useStockOverlays, type CompareSeries } from "./chart/useStockOverlays.ts";
import { DateRangeBar } from "./DateRangeBar.tsx";
import { presetRange, type RangePreset } from "./range.ts";
import { SymbolDetails } from "./details/SymbolDetails.tsx";
import { fmtDay } from "./format.ts";
import { getSnapshot } from "./market.ts";
import {
  fetchBars,
  refreshScans,
  useAssets,
  useHistory,
  useHoldings,
  useScanReport,
  useUniverse,
} from "./queries.ts";
import { useStocksUi, type BottomTab, type OverlayId } from "./store.ts";
import { IndicatorsDialog } from "./toolbar/IndicatorsDialog.tsx";
import { buildSearchItems, type SearchMode } from "./toolbar/searchItems.ts";
import { SymbolSearch } from "./toolbar/SymbolSearch.tsx";
import { TF_LABEL } from "./toolbar/labels.ts";
import { TopBar } from "./toolbar/TopBar.tsx";
import { buildSections, divTag, stochTag } from "./watchlist/model.ts";
import { Watchlist } from "./watchlist/Watchlist.tsx";

/**
 * The stock workspace: one question first — "which of my names need action
 * at the next open?" — answered by the watchlist's Divergence Buy and
 * Positions sections beside a full chart, with the evidence (the strategy's
 * own history on the charted name) one tab below.
 */

const CHART_PALETTE = {
  background: MINI_PALETTE.background,
  text: "#8a8c92",
  grid: "#1b1a1f",
  crosshair: "#5a5a60",
  up: "#44a282",
  down: "#e5566f",
  volumeUp: "rgba(68,162,130,0.22)",
  volumeDown: "rgba(229,86,111,0.22)",
  watermark: "rgba(255,255,255,0.025)",
};

const BOTTOM_TABS: { id: BottomTab; label: string }[] = [
  { id: "tester", label: "Strategy tester" },
  { id: "divbuy", label: "Divergence Buy" },
  { id: "stoch", label: "Stoch 4-cross" },
  { id: "holdings", label: "Your positions" },
];

function useDrag(onDelta: (dx: number, dy: number) => void, onEnd?: () => void) {
  return (e: React.PointerEvent) => {
    e.preventDefault();
    let x = e.clientX;
    let y = e.clientY;
    const move = (ev: PointerEvent) => {
      onDelta(ev.clientX - x, ev.clientY - y);
      x = ev.clientX;
      y = ev.clientY;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onEnd?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
}

function useNarrow(): boolean {
  const query = "(max-width: 767px)";
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

export function StockWorkspace() {
  const t = useTerminal();
  const qc = useQueryClient();
  const chartPrefs = useChartPreferences();
  const ui = useStocksUi();

  // ── Server data ──
  const { report: scanQ, status: statusQ } = useScanReport();
  const holdingsQ = useHoldings();
  const universeQ = useUniverse();
  const report = scanQ.data;
  const universe = universeQ.data;
  const heldSymbols = useMemo(() => (holdingsQ.data?.open ?? []).map((h) => h.symbol), [holdingsQ.data]);
  const assetSymbols = useMemo(
    () => [...new Set([...(universe ?? []).map((e) => e.symbol), ...heldSymbols, ...ui.watchlist])],
    [universe, heldSymbols, ui.watchlist],
  );
  const assetsQ = useAssets(assetSymbols);

  const symbol = t.selectedSymbol;
  const selectSymbol = t.setSelectedSymbol;
  const divRow = report?.div.find((r) => r.symbol === symbol);
  const stochRow = report?.stoch.find((r) => r.symbol === symbol);
  const asset = assetsQ.data?.find((a) => a.symbol === symbol);
  const exchange = universe?.find((e) => e.symbol === symbol)?.exchange;
  const holding = holdingsQ.data?.open.find((h) => h.symbol === symbol);

  // The terminal remembers an interval per symbol; a stock workspace keeps
  // one interval as you flip through names, the way TradingView does.
  const chartInterval = ui.interval;
  const setChartInterval = ui.setInterval;
  useEffect(() => {
    if (t.timeframe !== chartInterval) t.setTimeframe(chartInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, chartInterval]);
  const changeInterval = (tf: Timeframe) => {
    setChartInterval(tf);
    setRangePreset(null);
  };

  // First run lands on a stock instead of the demo's crypto default.
  useEffect(() => {
    if (!universe || universe.length === 0) return;
    if (!/USD$/.test(symbol) || symbol.length <= 5) return;
    const pick =
      heldSymbols[0] ??
      report?.div.find((r) => r.state === "NEW")?.symbol ??
      universe[0]!.symbol;
    selectSymbol(pick);
  }, [universe, symbol, heldSymbols, report, selectSymbol]);

  // ── Live prices for everything on screen ──
  const interest = useMemo(() => {
    const s = new Set<string>([symbol, ...heldSymbols, ...ui.watchlist, ...ui.compare]);
    ui.alerts.forEach((a) => s.add(a.symbol));
    report?.div.forEach((r) => r.state && s.add(r.symbol));
    report?.stoch.forEach((r) => r.fresh && r.stage && s.add(r.symbol));
    if (ui.collapsed.universe === false) universe?.forEach((e) => s.add(e.symbol));
    ui.gridSymbols.slice(0, ui.grid - 1).forEach((x) => x && s.add(x));
    return [...s].sort();
  }, [symbol, heldSymbols, ui.watchlist, ui.compare, ui.alerts, report, ui.collapsed, universe, ui.gridSymbols, ui.grid]);
  const interestKey = interest.join(",");
  useEffect(() => {
    wsClient.setSymbolInterest(interestKey ? interestKey.split(",") : []);
  }, [interestKey]);

  useAlertEngine();

  // ── Full history for the strategies (same span as the Python scans) ──
  const daily = useHistory(symbol, "1d");
  const weekly = useHistory(ui.overlays.stoch4x ? symbol : "", "1w");
  const strategy = useMemo(() => (daily.data && daily.data.length > 30 ? divergenceStrategy(daily.data) : null), [daily.data]);
  // "Now" decides whether this week's bar has closed; the history refetch
  // (every 15 min) is what moves it forward, so it is read when bars arrive.
  const weeklyAt = weekly.dataUpdatedAt;
  const stochMarkers = useMemo(
    () =>
      weekly.data && weekly.data.length > 30 ? stochStrategyMarkers(weekly.data, weeklyAt) : null,
    [weekly.data, weeklyAt],
  );

  // ── Compare ──
  const compareQs = useQueries({
    queries: ui.compare.map((s) => ({
      queryKey: ["stocks", "compare", s, t.timeframe],
      queryFn: () => fetchBars(s, t.timeframe, 1500),
      staleTime: 60_000,
    })),
  });
  const compareKey = compareQs.map((q) => q.dataUpdatedAt).join(",");
  const compare: CompareSeries[] = useMemo(
    () =>
      ui.compare.flatMap((s, i) => {
        const bars = compareQs[i]?.data;
        return bars && bars.length ? [{ symbol: s, bars }] : [];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ui.compare, compareKey],
  );

  // On a phone the chart comes first; the side panel is a sheet opened on demand.
  const narrow = useNarrow();
  const [sheetOpen, setSheetOpen] = useState(false);

  // ── Chart overlays ──
  const [api, setApi] = useState<ChartApiHandle | null>(null);
  const [bars, setBars] = useState<ChartBar[]>([]);
  // Rows the legend takes, so candles start below it (one row when folded).
  const legendRows =
    (["emaRibbon", "divBuy", "stoch4x", "divLines"] as const).filter((id) => ui.overlays[id]).length +
    (ui.compare.length > 0 ? 1 : 0);
  // In a 2- or 4-chart grid, or on a phone, the chart is small: keep the legend folded.
  const legendOpen = ui.legendOpen && ui.grid === 1 && !narrow;
  const legendPx = 26 + (legendOpen ? legendRows : Math.min(1, legendRows)) * 20;

  const overlay = useStockOverlays({
    api,
    bars,
    timeframe: t.timeframe,
    overlays: ui.overlays,
    activeIndicators: t.activeIndicators,
    volumeVisible: chartPrefs.showVolume,
    divMarkers: strategy?.markers ?? null,
    stochMarkers,
    compare,
    legendPx,
  });

  // ── Range presets ──
  const [rangePreset, setRangePreset] = useState<RangePreset | null>(null);
  const appliedFor = useRef("");
  useEffect(() => {
    if (!rangePreset || !api || bars.length === 0 || t.timeframe !== rangePreset.timeframe) return;
    const key = `${rangePreset.id}:${symbol}:${bars[bars.length - 1]!.time}`;
    if (appliedFor.current === key) return;
    appliedFor.current = key;
    const range = presetRange(rangePreset, bars[bars.length - 1]!.time);
    requestAnimationFrame(() => {
      try {
        if (!range) api.chart.timeScale().fitContent();
        else api.chart.timeScale().setVisibleRange({ from: range.from as never, to: range.to as never });
      } catch {
        /* range outside the data */
      }
    });
  }, [rangePreset, api, bars, t.timeframe, symbol]);
  const pickPreset = (p: RangePreset) => {
    appliedFor.current = "";
    setRangePreset(p);
    setChartInterval(p.timeframe);
  };

  const jumpTo = (time: number) => {
    if (!api) return;
    if (t.timeframe !== "1d") changeInterval("1d");
    requestAnimationFrame(() => {
      try {
        api.chart.timeScale().setVisibleRange({ from: (time - 120 * 86_400) as never, to: (time + 60 * 86_400) as never });
      } catch {
        /* not loaded yet */
      }
    });
  };

  // ── Dialogs and keyboard ──
  const [search, setSearch] = useState<{ mode: SearchMode; query: string; cell?: number } | null>(null);
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const [alertFor, setAlertFor] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (search || indicatorsOpen || alertFor || isTypingTarget(e.target)) return;
      if (e.altKey && (e.key === "a" || e.key === "å")) {
        e.preventDefault();
        setAlertFor(symbol);
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setIndicatorsOpen(true);
      } else if (/^[a-zA-Z]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // The letter seeds the query; without preventDefault it would also be
        // typed into the search field once it takes focus.
        e.preventDefault();
        setSearch({ mode: "chart", query: e.key.toUpperCase() });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [search, indicatorsOpen, alertFor, symbol]);

  const tags = useMemo(() => {
    const m = new Map<string, ReturnType<typeof divTag>>();
    report?.div.forEach((r) => {
      const tag = divTag(r);
      if (tag) m.set(r.symbol, tag);
    });
    report?.stoch.forEach((r) => {
      const tag = stochTag(r);
      if (tag && !m.has(r.symbol)) m.set(r.symbol, tag);
    });
    return m as Map<string, NonNullable<ReturnType<typeof divTag>>>;
  }, [report]);
  const searchItems = useMemo(
    () =>
      buildSearchItems({
        universe: universe ?? [],
        assets: assetsQ.data ?? [],
        held: heldSymbols,
        watchlist: ui.watchlist,
        tags,
      }),
    [universe, assetsQ.data, heldSymbols, ui.watchlist, tags],
  );

  const onPick = (picked: string) => {
    if (!search) return;
    if (search.mode === "chart") selectSymbol(picked);
    else if (search.mode === "compare") {
      if (picked !== symbol) ui.addCompare(picked);
    } else if (search.mode === "watchlist") ui.addToWatchlist(picked);
    else if (search.mode === "grid" && search.cell != null) ui.setGridSymbol(search.cell, picked);
  };

  const snapshot = () => {
    if (!api) return;
    try {
      const canvas = api.chart.takeScreenshot();
      const a = document.createElement("a");
      a.download = `${symbol}-${TF_LABEL[t.timeframe]}-${new Date().toISOString().slice(0, 10)}.png`;
      a.href = canvas.toDataURL("image/png");
      a.click();
    } catch {
      toast.error("Snapshot failed", "The chart could not be captured");
    }
  };

  const sections = useMemo(
    () =>
      buildSections({
        report,
        holdings: holdingsQ.data,
        universe,
        watchlist: ui.watchlist,
      }),
    [report, holdingsQ.data, universe, ui.watchlist],
  );
  const held = useMemo(() => new Set(heldSymbols), [heldSymbols]);
  const scanSymbols = useMemo(() => new Set((universe ?? []).map((e) => e.symbol)), [universe]);

  // ── Resizing ──
  const startBottomDrag = useDrag((_, dy) => ui.setBottomHeight(useStocksUi.getState().bottomHeight - dy));
  const startRightDrag = useDrag((dx) => ui.setRightWidth(useStocksUi.getState().rightWidth - dx));

  const scanHeader = (
    <ScanHeaderStatus report={report} status={statusQ.data} onRefresh={() => void refreshScans(qc)} />
  );

  const legendTitle = (
    <span className="flex items-baseline gap-2 font-sans">
      <span className="text-[14px] font-semibold text-[var(--ink)]">{symbol}</span>
      {ui.grid === 1 && asset?.name && asset.name !== symbol && (
        <span className="max-w-[280px] truncate text-[12px] text-[var(--mute)]">{asset.name}</span>
      )}
      <span className="shrink-0 text-[12px] text-[var(--mute)]">
        {TF_LABEL[t.timeframe]}
        {exchange ? ` · ${exchange}` : ""}
      </span>
    </span>
  );

  const legendBelow = overlay.legend.length > 0 && (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => ui.setLegendOpen(!legendOpen)}
        className="flex h-5 w-max items-center gap-1 font-sans text-[11px] text-[var(--mute)] hover:text-[var(--ink)]"
        aria-expanded={legendOpen}
      >
        {legendOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {legendOpen ? "Hide indicator legend" : `${overlay.legend.length} indicators`}
      </button>
      {legendOpen && overlay.legend.map((item) => (
        <LegendRow
          key={item.id}
          title={item.title}
          detail={item.detail}
          dim={!!item.inactiveReason}
          note={item.inactiveReason}
          values={item.values}
          onHide={
            item.id === "compare"
              ? undefined
              : () => ui.toggleOverlay(item.id as OverlayId)
          }
          onRemove={item.id === "compare" ? () => ui.compare.forEach((s) => ui.removeCompare(s)) : undefined}
        />
      ))}
    </div>
  );

  const priceArea = overlay.priceAreaHeight;
  const paneAxes =
    priceArea > 0 &&
    overlay.axisWidth > 0 &&
    overlay.paneAxes.map((a) => (
      <div
        key={`axis-${a.scaleId}`}
        className="pointer-events-none absolute right-0 z-[6] border-l border-[var(--rule)]"
        style={{ top: a.top, height: a.height, width: overlay.axisWidth, background: CHART_PALETTE.background }}
        aria-hidden
      >
        {a.scaleId !== "volume" && <div className="h-px w-full bg-[var(--edge)]" />}
        {a.ticks.map((tk) => (
          <span
            key={tk.label}
            className="num absolute left-2 -translate-y-1/2 text-[11px] text-[var(--mute)]"
            style={{ top: tk.y }}
          >
            {tk.label}
          </span>
        ))}
      </div>
    ));
  const paneOverlay =
    priceArea > 0 &&
    overlay.layout.panes.map((p, i) => {
      const info = overlay.panes[i];
      return (
        <div key={p.scaleId} className="pointer-events-none absolute inset-x-0 z-[5]" style={{ top: p.start * priceArea }}>
          <div className="h-px w-full bg-[var(--edge)]" />
          <div className="ml-3 mt-1 flex items-center gap-2 text-[11px]">
            <span className="text-[var(--ink-2)]">{info?.title}</span>
            {info?.values.map((v) => (
              <span key={v.label} className="num" style={{ color: v.color }}>
                {v.value}
              </span>
            ))}
          </div>
        </div>
      );
    });

  const gridCells = ui.grid - 1;
  // Unset cells show your positions, then the scan list, never the main symbol twice.
  const gridDefaults = [...new Set([...heldSymbols, ...(universe ?? []).map((e) => e.symbol)])].filter(
    (s) => s !== symbol,
  );
  const mainChart = (
    <div className="relative min-h-0 min-w-0 flex-1">
      <ChartPanel
        candles={t.candles ?? []}
        selectedSymbol={symbol}
        timeframe={t.timeframe}
        isDark
        activeIndicators={t.activeIndicators}
        drawingTool={t.drawingTool}
        drawings={t.drawings}
        onAddDrawing={t.addDrawing}
        onUpdateDrawing={t.updateDrawing}
        onRemoveDrawing={t.removeDrawing}
        onDrawingComplete={() => t.setDrawingTool("none")}
        onDrawingToolSelect={t.setDrawingTool}
        onUndoDrawing={t.undoDrawing}
        onRedoDrawing={t.redoDrawing}
        magnetMode={t.chartPrefs.magnetMode}
        stayInDrawingMode={t.chartPrefs.stayInDrawingMode}
        positions={[]}
        orders={[]}
        tick={t.tick}
        liveCandle={t.liveCandle}
        pipDigits={2}
        symbolInfo={t.symbolInfo}
        activePlugins={t.activePlugins}
        onTogglePlugin={t.togglePlugin}
        onClearDrawings={t.clearDrawings}
        onClearIndicators={() => {
          t.clearIndicators();
          (Object.keys(ui.overlays) as OverlayId[]).forEach((id) => ui.setOverlay(id, false));
        }}
        chartStyle={ui.chartStyle}
        priceLabel="last"
        staleWatchdog={false}
        extraMarkers={overlay.markers}
        legendTitle={legendTitle}
        legendBelow={legendBelow}
        onChartApi={setApi}
        onChartData={setBars}
        palette={CHART_PALETTE}
        legendInset={52}
        showNews={false}
      >
        {paneOverlay}
        {paneAxes}
      </ChartPanel>
    </div>
  );

  const rightOpen = narrow ? sheetOpen : ui.rightPanel !== "none";
  const sidePanel = ui.rightPanel === "none" ? "watchlist" : ui.rightPanel;

  return (
    <div className="stocks-ws flex h-full w-full flex-col overflow-hidden">
      <TopBar
        symbol={symbol}
        symbolName={asset?.name}
        onOpenSearch={() => setSearch({ mode: "chart", query: "" })}
        onOpenCompare={() => setSearch({ mode: "compare", query: "" })}
        timeframe={t.timeframe}
        onTimeframe={changeInterval}
        chartStyle={ui.chartStyle}
        onChartStyle={ui.setChartStyle}
        onOpenIndicators={() => setIndicatorsOpen(true)}
        onCreateAlert={() => setAlertFor(symbol)}
        grid={ui.grid}
        onGrid={ui.setGrid}
        onUndo={t.undoDrawing}
        onRedo={t.redoDrawing}
        onSnapshot={snapshot}
        onToggleSheet={() => setSheetOpen((v) => !v)}
        sheetOpen={sheetOpen}
        status={
          <div className="flex items-center gap-1">
            <span className="hidden text-[12px] text-[var(--mute)] xl:inline">
              {statusQ.data?.running
                ? `Scanning ${statusQ.data.done}/${statusQ.data.total}`
                : report
                  ? `Scans to ${fmtDay(report.asOf)}`
                  : scanQ.isError
                    ? "Scans unavailable"
                    : ""}
            </span>
            <span
              className="ml-2 inline-flex items-center gap-1.5 text-[12px] text-[var(--mute)]"
              title={t.isFeedConnected ? "Prices polling Alpaca (IEX trades, about every 5 s)" : "No price feed"}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.isFeedConnected ? "var(--pos)" : "var(--neg)" }} />
              <span className="hidden lg:inline">{t.isFeedConnected ? "Live · IEX" : "Offline"}</span>
            </span>
          </div>
        }
      />

      {scanQ.isError && (
        <div className="border-b border-[var(--edge)] bg-[var(--pill-warn-bg)] px-4 py-1.5 text-[12px] text-[var(--pill-warn-ink)]">
          Scans unavailable: {scanQ.error.message}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Chart column */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            className={cn(
              "grid min-h-0 flex-1 gap-px bg-[var(--edge)]",
              ui.grid === 1 && "grid-cols-1",
              ui.grid === 2 && "grid-cols-1 md:grid-cols-2",
              ui.grid === 4 && "grid-cols-1 md:grid-cols-2 md:grid-rows-2",
            )}
          >
            <div className="flex min-h-0 min-w-0 bg-[var(--surface)]">{mainChart}</div>
            {Array.from({ length: gridCells }, (_, i) => {
              const cellSymbol = ui.gridSymbols[i] || gridDefaults[i] || "SPY";
              return (
                <MiniChart
                  key={i}
                  symbol={cellSymbol}
                  timeframe={t.timeframe}
                  onChangeSymbol={() => setSearch({ mode: "grid", query: "", cell: i })}
                  onMakeMain={() => {
                    ui.setGridSymbol(i, symbol);
                    selectSymbol(cellSymbol);
                  }}
                />
              );
            })}
          </div>
          <DateRangeBar active={rangePreset?.id ?? null} onPick={pickPreset} />

          {/* Bottom panel */}
          {ui.bottomOpen && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize bottom panel"
              onPointerDown={startBottomDrag}
              className="hidden h-1 shrink-0 cursor-row-resize bg-[var(--ground)] hover:bg-[var(--line-accent)] md:block"
            />
          )}
          <div
            className="flex shrink-0 flex-col border-t border-[var(--edge)] bg-[var(--surface)]"
            style={{ height: ui.bottomOpen ? (narrow ? Math.min(ui.bottomHeight, 240) : ui.bottomHeight) : 36 }}
          >
            <div className="flex h-9 shrink-0 items-center gap-5 overflow-x-auto border-b border-[var(--rule)] px-4 [scrollbar-width:none]">
              {BOTTOM_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className="sel h-full shrink-0 text-[13px] text-[var(--ink-2)] hover:text-[var(--ink)] data-[on=true]:text-[var(--ink)]"
                  data-on={ui.bottomOpen && ui.bottomTab === tab.id}
                  onClick={() => ui.setBottomTab(tab.id)}
                >
                  {tab.label}
                  {tab.id === "divbuy" && report && (
                    <span className="num ml-1.5 text-[var(--mute)]">{report.div.filter((r) => r.state === "NEW" || r.state === "EXIT").length}</span>
                  )}
                  {tab.id === "holdings" && holdingsQ.data && (
                    <span className="num ml-1.5 text-[var(--mute)]">{holdingsQ.data.open.length}</span>
                  )}
                </button>
              ))}
              <button
                type="button"
                className="tbtn ml-auto !h-7 !px-1.5"
                onClick={() => ui.setBottomOpen(!ui.bottomOpen)}
                aria-label={ui.bottomOpen ? "Collapse panel" : "Expand panel"}
                title={ui.bottomOpen ? "Collapse panel" : "Expand panel"}
              >
                {ui.bottomOpen ? <PanelBottomClose className="h-4 w-4" /> : <PanelBottomOpen className="h-4 w-4" />}
              </button>
            </div>
            {ui.bottomOpen && (
              <div className="min-h-0 flex-1">
                {ui.bottomTab === "tester" && (
                  <StrategyTester
                    symbol={symbol}
                    result={strategy}
                    loading={daily.isLoading}
                    noData={!!daily.data && daily.data.length <= 30}
                    error={daily.isError ? daily.error.message : null}
                    rangeLabel={
                      daily.data?.length
                        ? `${fmtDay(daily.data[0]!.time)} – ${fmtDay(daily.data[daily.data.length - 1]!.time)}`
                        : ""
                    }
                    onJumpTo={jumpTo}
                  />
                )}
                {ui.bottomTab === "divbuy" && (
                  <DivBuyTable rows={report?.div ?? []} held={held} onSelect={selectSymbol} header={scanHeader} />
                )}
                {ui.bottomTab === "stoch" && (
                  <StochTable rows={report?.stoch ?? []} held={held} onSelect={selectSymbol} header={scanHeader} />
                )}
                {ui.bottomTab === "holdings" && (
                  <HoldingsTable
                    report={holdingsQ.data}
                    loading={holdingsQ.isLoading}
                    error={holdingsQ.isError ? holdingsQ.error.message : null}
                    onSelect={selectSymbol}
                    scanSymbols={scanSymbols}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right panel */}
        {rightOpen && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize side panel"
              onPointerDown={startRightDrag}
              className="hidden w-1 shrink-0 cursor-col-resize bg-[var(--ground)] hover:bg-[var(--line-accent)] md:block"
            />
            <aside
              className="fixed inset-x-0 bottom-0 top-11 z-30 flex flex-col border-l border-[var(--edge)] md:static md:z-auto md:w-[var(--rw)] md:shrink-0"
              style={{ ["--rw" as string]: `${ui.rightWidth}px`, background: "var(--ground)" }}
            >
              {narrow && (
                <div className="flex h-10 shrink-0 items-center gap-4 border-b border-[var(--edge)] px-3">
                  {(["watchlist", "alerts"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      className="sel h-full text-[13px] text-[var(--ink-2)] data-[on=true]:text-[var(--ink)]"
                      data-on={sidePanel === p}
                      onClick={() => ui.setRightPanel(p)}
                    >
                      {p === "watchlist" ? "Watchlist" : "Alerts"}
                    </button>
                  ))}
                  <button type="button" className="tbtn ml-auto !h-7 !px-1.5" onClick={() => setSheetOpen(false)} aria-label="Close panel">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
              {sidePanel === "watchlist" ? (
                <>
                  <Watchlist
                    sections={sections}
                    selected={symbol}
                    onSelect={(s) => {
                      selectSymbol(s);
                      if (narrow) setSheetOpen(false);
                    }}
                    onAdd={() => setSearch({ mode: "watchlist", query: "" })}
                    loading={{ scans: scanQ.isLoading || !!statusQ.data?.running && !report, holdings: holdingsQ.isLoading }}
                  />
                  {ui.detailsOpen && (
                    <div className="max-h-[52%] min-h-[200px] shrink-0 overflow-hidden">
                      <SymbolDetails
                        symbol={symbol}
                        asset={asset}
                        exchange={exchange}
                        holding={holding}
                        div={divRow}
                        stoch={stochRow}
                        inWatchlist={ui.watchlist.includes(symbol)}
                        onToggleWatchlist={() =>
                          ui.watchlist.includes(symbol) ? ui.removeFromWatchlist(symbol) : ui.addToWatchlist(symbol)
                        }
                        onAddAlert={() => setAlertFor(symbol)}
                        noData={!!daily.data && daily.data.length === 0}
                      />
                    </div>
                  )}
                </>
              ) : (
                <AlertsList
                  onSelect={(s) => {
                    selectSymbol(s);
                    if (narrow) setSheetOpen(false);
                  }}
                />
              )}
            </aside>
          </>
        )}

        {/* Right rail */}
        <nav aria-label="Side panels" className="hidden w-11 shrink-0 flex-col items-center gap-1 border-l border-[var(--edge)] bg-[var(--surface)] py-2 md:flex">
          <RailButton
            label="Watchlist and details"
            on={ui.rightPanel === "watchlist"}
            onClick={() => ui.setRightPanel(ui.rightPanel === "watchlist" ? "none" : "watchlist")}
          >
            <List className="h-[18px] w-[18px]" />
          </RailButton>
          <RailButton
            label="Alerts"
            on={ui.rightPanel === "alerts"}
            onClick={() => ui.setRightPanel(ui.rightPanel === "alerts" ? "none" : "alerts")}
          >
            <Bell className="h-[18px] w-[18px]" />
          </RailButton>
          {ui.rightPanel === "watchlist" && (
            <RailButton label={ui.detailsOpen ? "Hide details" : "Show details"} on={false} onClick={() => ui.setDetailsOpen(!ui.detailsOpen)}>
              {ui.detailsOpen ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
            </RailButton>
          )}
        </nav>
      </div>

      {search && (
        <SymbolSearch
          mode={search.mode}
          items={searchItems}
          initialQuery={search.query}
          onPick={onPick}
          onClose={() => setSearch(null)}
        />
      )}
      {indicatorsOpen && (
        <IndicatorsDialog
          overlays={ui.overlays}
          onToggleOverlay={ui.toggleOverlay}
          activeIndicators={t.activeIndicators}
          onToggleIndicator={t.toggleIndicator}
          onClose={() => setIndicatorsOpen(false)}
        />
      )}
      {alertFor && (
        <AlertDialog
          symbol={alertFor}
          defaultPrice={getSnapshot(alertFor)?.last ?? null}
          onClose={() => setAlertFor(null)}
        />
      )}
    </div>
  );
}

function RailButton({
  label,
  on,
  onClick,
  children,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      title={label}
      className={cn(
        "relative flex h-9 w-9 items-center justify-center rounded-[6px] text-[var(--mute)] hover:bg-[var(--raised)] hover:text-[var(--ink)]",
        on && "text-[var(--ink)]",
      )}
    >
      {on && <span className="absolute -left-[5px] inset-y-2 w-px bg-[var(--line-accent)]" />}
      {children}
    </button>
  );
}

function LegendRow({
  title,
  detail,
  values,
  dim,
  note,
  onHide,
  onRemove,
}: {
  title: string;
  detail?: string;
  values: { label: string; value: string; color: string }[];
  dim: boolean;
  note?: string;
  onHide?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="group flex h-5 items-center gap-2 font-sans text-[12px]">
      <span className={dim ? "text-[var(--mute)]" : "text-[var(--ink-2)]"}>{title}</span>
      {detail && <span className="text-[11px] text-[var(--mute)]">{detail}</span>}
      {note && <span className="text-[11px] text-[var(--mute)]">· {note}</span>}
      {values.map((v) => (
        <span key={v.label} className="num text-[11px]" style={{ color: v.color }}>
          {v.label && v.value ? `${v.label} ` : v.label}
          {v.value}
        </span>
      ))}
      {onHide && (
        <button type="button" onClick={onHide} className="hidden rounded p-0.5 text-[var(--mute)] hover:text-[var(--ink)] group-hover:inline-flex" aria-label={`Remove ${title}`} title="Remove (re-add from Indicators)">
          <X className="h-3 w-3" />
        </button>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} className="hidden rounded p-0.5 text-[var(--mute)] hover:text-[var(--ink)] group-hover:inline-flex" aria-label="Stop comparing" title="Stop comparing">
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

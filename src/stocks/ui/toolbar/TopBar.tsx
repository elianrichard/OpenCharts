import {
  BarChart3,
  BellPlus,
  CandlestickChart,
  Camera,
  ChevronDown,
  Columns2,
  Grid2x2,
  LineChart,
  List,
  Maximize,
  Plus,
  Redo2,
  Search,
  Square,
  Undo2,
  AreaChart,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChartStyle } from "../../../pages/trading/ChartPanel.tsx";
import { TIMEFRAMES, type Timeframe } from "../../../pages/trading/constants.ts";
import { cn } from "../../../lib/utils.ts";
import type { GridLayout } from "../store.ts";
import { TF_LABEL } from "./labels.ts";

/**
 * The toolbar, in TradingView's order: symbol, compare, favourite intervals,
 * chart style, indicators, alert | layout, undo/redo | snapshot, fullscreen.
 * The right end carries the scan status and the market clock.
 */

const TF_NAME: Record<Timeframe, string> = {
  "1m": "1 minute",
  "5m": "5 minutes",
  "15m": "15 minutes",
  "30m": "30 minutes",
  "1h": "1 hour",
  "4h": "4 hours",
  "1d": "1 day",
  "1w": "1 week",
};
const FAVORITE_TFS: Timeframe[] = ["15m", "1h", "4h", "1d", "1w"];

const STYLES: { id: ChartStyle; label: string; icon: ReactNode }[] = [
  { id: "candles", label: "Candles", icon: <CandlestickChart className="h-4 w-4" /> },
  { id: "hollow", label: "Hollow candles", icon: <CandlestickChart className="h-4 w-4 opacity-70" /> },
  { id: "heikin", label: "Heikin Ashi", icon: <CandlestickChart className="h-4 w-4" /> },
  { id: "bars", label: "Bars", icon: <BarChart3 className="h-4 w-4" /> },
  { id: "line", label: "Line", icon: <LineChart className="h-4 w-4" /> },
  { id: "area", label: "Area", icon: <AreaChart className="h-4 w-4" /> },
];

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

function Dropdown({
  label,
  title,
  children,
  align = "left",
}: {
  label: ReactNode;
  title: string;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="tbtn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        aria-label={title}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <ChevronDown className="h-3 w-3 text-[var(--mute)]" />
      </button>
      {open && (
        <div role="menu" className={cn("menu absolute top-9 z-40 min-w-[180px]", align === "right" ? "right-0" : "left-0")}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

export function TopBar({
  symbol,
  symbolName,
  onOpenSearch,
  onOpenCompare,
  timeframe,
  onTimeframe,
  chartStyle,
  onChartStyle,
  onOpenIndicators,
  onCreateAlert,
  grid,
  onGrid,
  onUndo,
  onRedo,
  onSnapshot,
  status,
  onToggleSheet,
  sheetOpen,
}: {
  symbol: string;
  symbolName: string | undefined;
  onOpenSearch: () => void;
  onOpenCompare: () => void;
  timeframe: Timeframe;
  onTimeframe: (tf: Timeframe) => void;
  chartStyle: ChartStyle;
  onChartStyle: (s: ChartStyle) => void;
  onOpenIndicators: () => void;
  onCreateAlert: () => void;
  grid: GridLayout;
  onGrid: (g: GridLayout) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSnapshot: () => void;
  status: ReactNode;
  /** Phones: open the watchlist sheet. */
  onToggleSheet: () => void;
  sheetOpen: boolean;
}) {
  const style = STYLES.find((s) => s.id === chartStyle) ?? STYLES[0]!;
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  };

  return (
    <header className="flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--edge)] bg-[var(--surface)] px-2 [scrollbar-width:none]">
      <span
        className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-[var(--raised)]"
        aria-label="OpenCharts stocks"
        title="OpenCharts · US stocks"
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
          <path d="M2 12 L6 7 L9 9.5 L14 3" fill="none" stroke="#4a8ad6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>

      <button
        type="button"
        className="tbtn min-w-[96px] !justify-start bg-[var(--raised)] !text-[var(--ink)]"
        onClick={onOpenSearch}
        title={symbolName ? `${symbol} · ${symbolName}. Search (or start typing on the chart)` : "Symbol search"}
        aria-label={`Symbol ${symbol}. Open symbol search`}
      >
        <Search className="h-3.5 w-3.5 text-[var(--mute)]" />
        <span className="font-semibold">{symbol}</span>
      </button>
      <button type="button" className="tbtn !px-1.5" onClick={onOpenCompare} title="Compare symbols" aria-label="Compare symbols">
        <Plus className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="tbtn !px-1.5 md:!hidden"
        onClick={onToggleSheet}
        aria-pressed={sheetOpen}
        aria-label="Watchlist and alerts"
      >
        <List className="h-4 w-4" />
      </button>

      <span className="vsep" />
      {FAVORITE_TFS.map((tf) => (
        <button
          key={tf}
          type="button"
          className="tbtn sel !px-2 [--sel-inset:8px]"
          data-on={timeframe === tf}
          aria-pressed={timeframe === tf}
          onClick={() => onTimeframe(tf)}
          title={TF_NAME[tf]}
        >
          {TF_LABEL[tf]}
        </button>
      ))}
      <Dropdown label={FAVORITE_TFS.includes(timeframe) ? null : TF_LABEL[timeframe]} title="Chart interval">
        {(close) =>
          TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              role="menuitemradio"
              aria-checked={timeframe === tf}
              data-active={timeframe === tf}
              className="menu-item"
              onClick={() => {
                onTimeframe(tf);
                close();
              }}
            >
              <span className="num w-8">{TF_LABEL[tf]}</span>
              <span className="text-[var(--mute)]">{TF_NAME[tf]}</span>
            </button>
          ))
        }
      </Dropdown>

      <span className="vsep" />
      <Dropdown label={style.icon} title={`Chart style: ${style.label}`}>
        {(close) =>
          STYLES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="menuitemradio"
              aria-checked={chartStyle === s.id}
              data-active={chartStyle === s.id}
              className="menu-item"
              onClick={() => {
                onChartStyle(s.id);
                close();
              }}
            >
              {s.icon}
              {s.label}
            </button>
          ))
        }
      </Dropdown>
      <button type="button" className="tbtn" onClick={onOpenIndicators} title="Indicators (/)" aria-label="Indicators">
        <span className="text-[13px]">Indicators</span>
      </button>
      <button type="button" className="tbtn" onClick={onCreateAlert} title="Create alert (Alt+A)" aria-label="Create alert">
        <BellPlus className="h-4 w-4" />
        <span className="hidden lg:inline">Alert</span>
      </button>

      <span className="vsep" />
      <Dropdown
        label={grid === 1 ? <Square className="h-4 w-4" /> : grid === 2 ? <Columns2 className="h-4 w-4" /> : <Grid2x2 className="h-4 w-4" />}
        title="Layout"
      >
        {(close) =>
          ([
            [1, "1 chart", <Square key="1" className="h-4 w-4" />],
            [2, "2 charts", <Columns2 key="2" className="h-4 w-4" />],
            [4, "4 charts", <Grid2x2 key="4" className="h-4 w-4" />],
          ] as const).map(([g, label, icon]) => (
            <button
              key={g}
              type="button"
              role="menuitemradio"
              aria-checked={grid === g}
              data-active={grid === g}
              className="menu-item"
              onClick={() => {
                onGrid(g);
                close();
              }}
            >
              {icon}
              {label}
            </button>
          ))
        }
      </Dropdown>
      <button type="button" className="tbtn !px-1.5" onClick={onUndo} title="Undo drawing (⌘Z)" aria-label="Undo drawing">
        <Undo2 className="h-4 w-4" />
      </button>
      <button type="button" className="tbtn !px-1.5" onClick={onRedo} title="Redo drawing (⇧⌘Z)" aria-label="Redo drawing">
        <Redo2 className="h-4 w-4" />
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-2">
        {status}
        <span className="vsep" />
        <button type="button" className="tbtn !px-1.5" onClick={onSnapshot} title="Save chart image" aria-label="Save chart image">
          <Camera className="h-4 w-4" />
        </button>
        <button type="button" className="tbtn !px-1.5" onClick={fullscreen} title="Fullscreen" aria-label="Fullscreen">
          <Maximize className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

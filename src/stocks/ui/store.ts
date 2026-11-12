import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ChartStyle } from "../../pages/trading/ChartPanel.tsx";
import type { Timeframe } from "../../pages/trading/constants.ts";

/**
 * Workspace state that belongs to this browser: layout, which overlays are
 * on, the watchlist's extra tickers and flags, compare symbols and alerts.
 * Scan results and holdings are never stored here; they come from the server.
 */

export type OverlayId =
  | "emaRibbon"
  | "divBuy"
  | "divLines"
  | "stochRsi"
  | "stoch4x";

export type BottomTab = "tester" | "divbuy" | "stoch" | "holdings" | "alerts";
export type RightPanel = "watchlist" | "alerts" | "none";
export type GridLayout = 1 | 2 | 4;

export interface PriceAlert {
  id: string;
  symbol: string;
  /** "crossing" fires either way; "above"/"below" only when crossing that way. */
  condition: "crossing" | "above" | "below";
  price: number;
  note: string;
  createdAt: number;
  /** Epoch ms of the last trigger; null while armed. */
  triggeredAt: number | null;
  /** Re-arm after triggering (TradingView "Every time"). */
  repeat: boolean;
  /** Switched off by the user. */
  paused: boolean;
}

/** Will this alert fire on the next crossing? */
export function isArmed(a: PriceAlert): boolean {
  return !a.paused && (a.triggeredAt == null || a.repeat);
}

export interface AlertEvent {
  id: string;
  alertId: string;
  symbol: string;
  message: string;
  price: number;
  at: number;
}

export type FlagColor = "red" | "amber" | "green" | "blue";

interface StocksUiState {
  chartStyle: ChartStyle;
  /** One interval for every symbol, as on TradingView. Daily by default: the scans are daily. */
  interval: Timeframe;
  legendOpen: boolean;
  overlays: Record<OverlayId, boolean>;
  bottomTab: BottomTab;
  bottomOpen: boolean;
  bottomHeight: number;
  rightPanel: RightPanel;
  rightWidth: number;
  detailsOpen: boolean;
  grid: GridLayout;
  /** Symbols in the extra grid cells (cell 0 is the main chart). */
  gridSymbols: string[];
  /** The user's own tickers, shown as the "Watchlist" section. */
  watchlist: string[];
  collapsed: Record<string, boolean>;
  flags: Record<string, FlagColor>;
  compare: string[];
  alerts: PriceAlert[];
  alertLog: AlertEvent[];

  setChartStyle: (s: ChartStyle) => void;
  setInterval: (tf: Timeframe) => void;
  setLegendOpen: (open: boolean) => void;
  toggleOverlay: (id: OverlayId) => void;
  setOverlay: (id: OverlayId, on: boolean) => void;
  setBottomTab: (t: BottomTab) => void;
  setBottomOpen: (open: boolean) => void;
  setBottomHeight: (h: number) => void;
  setRightPanel: (p: RightPanel) => void;
  setRightWidth: (w: number) => void;
  setDetailsOpen: (open: boolean) => void;
  setGrid: (g: GridLayout) => void;
  setGridSymbol: (index: number, symbol: string) => void;
  addToWatchlist: (symbol: string) => void;
  removeFromWatchlist: (symbol: string) => void;
  toggleCollapsed: (section: string) => void;
  cycleFlag: (symbol: string) => void;
  addCompare: (symbol: string) => void;
  removeCompare: (symbol: string) => void;
  addAlert: (a: Omit<PriceAlert, "id" | "createdAt" | "triggeredAt" | "paused">) => void;
  updateAlert: (id: string, patch: Partial<PriceAlert>) => void;
  removeAlert: (id: string) => void;
  logAlert: (e: Omit<AlertEvent, "id">) => void;
  clearAlertLog: () => void;
}

const FLAG_CYCLE: (FlagColor | undefined)[] = [undefined, "red", "amber", "green", "blue"];

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const useStocksUi = create<StocksUiState>()(
  persist(
    (set) => ({
      chartStyle: "candles",
      interval: "1d",
      legendOpen: true,
      overlays: {
        emaRibbon: true,
        divBuy: true,
        divLines: true,
        stochRsi: true,
        stoch4x: true,
      },
      bottomTab: "tester",
      bottomOpen: true,
      bottomHeight: 300,
      rightPanel: "watchlist",
      rightWidth: 340,
      detailsOpen: true,
      grid: 1,
      gridSymbols: [],
      watchlist: [],
      collapsed: {},
      flags: {},
      compare: [],
      alerts: [],
      alertLog: [],

      setChartStyle: (chartStyle) => set({ chartStyle }),
      setInterval: (interval) => set({ interval }),
      setLegendOpen: (legendOpen) => set({ legendOpen }),
      toggleOverlay: (id) => set((s) => ({ overlays: { ...s.overlays, [id]: !s.overlays[id] } })),
      setOverlay: (id, on) => set((s) => ({ overlays: { ...s.overlays, [id]: on } })),
      setBottomTab: (bottomTab) => set({ bottomTab, bottomOpen: true }),
      setBottomOpen: (bottomOpen) => set({ bottomOpen }),
      setBottomHeight: (h) => set({ bottomHeight: Math.round(Math.max(120, Math.min(640, h))) }),
      setRightPanel: (rightPanel) => set({ rightPanel }),
      setRightWidth: (w) => set({ rightWidth: Math.round(Math.max(280, Math.min(560, w))) }),
      setDetailsOpen: (detailsOpen) => set({ detailsOpen }),
      setGrid: (grid) => set({ grid }),
      setGridSymbol: (index, symbol) =>
        set((s) => {
          const next = [...s.gridSymbols];
          next[index] = symbol;
          return { gridSymbols: next };
        }),
      addToWatchlist: (symbol) =>
        set((s) => (s.watchlist.includes(symbol) ? s : { watchlist: [...s.watchlist, symbol] })),
      removeFromWatchlist: (symbol) =>
        set((s) => ({ watchlist: s.watchlist.filter((x) => x !== symbol) })),
      toggleCollapsed: (section) =>
        set((s) => ({ collapsed: { ...s.collapsed, [section]: !s.collapsed[section] } })),
      cycleFlag: (symbol) =>
        set((s) => {
          const at = FLAG_CYCLE.indexOf(s.flags[symbol]);
          const next = FLAG_CYCLE[(at + 1) % FLAG_CYCLE.length];
          const flags = { ...s.flags };
          if (next) flags[symbol] = next;
          else delete flags[symbol];
          return { flags };
        }),
      addCompare: (symbol) =>
        set((s) =>
          s.compare.includes(symbol) || s.compare.length >= 4
            ? s
            : { compare: [...s.compare, symbol] },
        ),
      removeCompare: (symbol) => set((s) => ({ compare: s.compare.filter((x) => x !== symbol) })),
      addAlert: (a) =>
        set((s) => ({
          alerts: [
            ...s.alerts,
            { ...a, id: uid(), createdAt: Date.now(), triggeredAt: null, paused: false },
          ],
        })),
      updateAlert: (id, patch) =>
        set((s) => ({ alerts: s.alerts.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
      removeAlert: (id) => set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) })),
      logAlert: (e) =>
        set((s) => ({ alertLog: [{ ...e, id: uid() }, ...s.alertLog].slice(0, 200) })),
      clearAlertLog: () => set({ alertLog: [] }),
    }),
    {
      name: "opencharts.stocks.ui",
      version: 1,
      storage: createJSONStorage(() => {
        try {
          return window.localStorage;
        } catch {
          // Private mode or blocked storage: keep state for this session only.
          const mem = new Map<string, string>();
          return {
            getItem: (k: string) => mem.get(k) ?? null,
            setItem: (k: string, v: string) => void mem.set(k, v),
            removeItem: (k: string) => void mem.delete(k),
          };
        }
      }),
    },
  ),
);

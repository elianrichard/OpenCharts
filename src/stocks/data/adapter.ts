import type {
  CandleRequest,
  ConnectionState,
  MarketDataSource,
  MarketEvent,
  OpenChartsAdapter,
  Quote,
  Unsubscribe,
} from "../../adapter/types.ts";
import type { Candle, Symbol } from "../../services/schemas.ts";
import type { AssetInfo, Bar, StockSnapshot } from "../types.ts";
import { createStocksClient, type StocksClient } from "./client.ts";
import { buildLiveBar, latestTrade, sameBar, tickTimestamp } from "./live.ts";
import { snapshotStore as defaultStore, type SnapshotStore } from "./snapshots.ts";
import { ET_TIMEZONE, isIntraday, isStockTimeframe, type StockTimeframe } from "./time.ts";

/**
 * OpenCharts adapter for US stocks through the local /stocks-api proxy
 * (Alpaca, keys server-side). Market data only, no trading.
 *
 * Live data is a poll, not a socket: every `pollMs` the adapter fetches
 * snapshots for the symbols on screen (setSymbolInterest, watchSymbols, and
 * the charted symbol) in one request and
 *   - fills the snapshot store (full StockSnapshot for the UI),
 *   - emits `candle` for each charted symbol/timeframe: the newest bar from
 *     /bars (refreshed every 15 s intraday, 60 s daily/weekly) with the latest
 *     trade folded in. This is what moves the chart's last bar,
 *   - then emits `tick` with bid = ask = the last trade (the chart closes on
 *     the bid/ask mid, and stock charts close on trades), only when that price
 *     changed since the previous poll. Its `timestamp` is chart-safe rather
 *     than the trade time (see tickTimestamp in ./live.ts): ChartPanel replays
 *     stored ticks onto whatever timeframe is shown next, and Alpaca's daily
 *     and weekly bars are off its UTC grid. Real trade times live on the
 *     snapshot (`lastTime`, `extended.time`).
 *
 * Connection state follows poll health: connecting -> connected, and
 * reconnecting (with backoff) while polls fail.
 */

export interface AlpacaAdapterOptions {
  client?: StocksClient;
  /** Defaults to the app-wide store exported from ./snapshots.ts. */
  store?: SnapshotStore;
  pollMs?: number;
  /** Poll interval while the tab is hidden. */
  hiddenPollMs?: number;
  /** How often a charted bar is re-read from /bars. */
  barRefreshMs?: { intraday: number; daily: number };
  /** Charted symbol/timeframe pairs kept live (most recent first). */
  maxCharts?: number;
  /** Symbols to offer besides list.txt (e.g. holdings outside the universe). */
  extraSymbols?: string[];
  now?: () => number;
}

export interface AlpacaMarketData extends MarketDataSource {
  /** Keep these symbols in the snapshot poll until the returned function runs. */
  watchSymbols(symbols: string[]): Unsubscribe;
  /**
   * Declare what the chart shows. getCandles calls without a window do this
   * implicitly; call it when bars are loaded some other way.
   */
  setActiveChart(symbol: string, timeframe: string): void;
  /** Poll now instead of waiting for the next interval. */
  pollNow(): Promise<void>;
}

export interface AlpacaAdapter extends OpenChartsAdapter {
  name: "alpaca";
  marketData: AlpacaMarketData;
  snapshots: SnapshotStore;
  client: StocksClient;
}

/** Bars to fetch when a scroll-back window comes back empty (overnight, weekends). */
const GAP_FILL_LIMIT = 500;

interface ChartStream {
  symbol: string;
  timeframe: StockTimeframe;
  base: Bar | null;
  fetchedAt: number;
  refreshing: boolean;
  emitted: Bar | null;
}

export const STOCK_TRADING_HOURS = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek,
  openTime: "09:30",
  closeTime: "16:00",
}));

/** An OpenCharts Symbol for a US stock. Extra fields ride along for the UI. */
export function stockSymbol(symbol: string, asset?: AssetInfo, exchange?: string): Symbol {
  return {
    id: symbol,
    name: symbol,
    displayName: asset?.name && asset.name !== symbol ? asset.name : null,
    category: "Stocks",
    contractSize: 1,
    tickSize: 0.01,
    tickValue: 0.01,
    marginPercent: 100,
    maxLeverage: 1,
    commission: 0,
    swapLong: 0,
    swapShort: 0,
    tradingHoursStart: "09:30",
    tradingHoursEnd: "16:00",
    isActive: asset?.tradable ?? true,
    // Not in SymbolSchema; read by MarketClosedBanner and available to the UI.
    exchange: asset?.exchange || exchange || "",
    sessionTimezone: ET_TIMEZONE,
    tradingHours: STOCK_TRADING_HOURS,
  } as Symbol;
}

function toCandle(bar: Bar): Candle {
  return { time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createAlpacaAdapter(options: AlpacaAdapterOptions = {}): AlpacaAdapter {
  const client = options.client ?? createStocksClient();
  const store = options.store ?? defaultStore;
  const pollMs = options.pollMs ?? 5_000;
  const hiddenPollMs = options.hiddenPollMs ?? 30_000;
  const barRefresh = options.barRefreshMs ?? { intraday: 15_000, daily: 60_000 };
  const maxCharts = Math.max(1, options.maxCharts ?? 2);
  const now = options.now ?? Date.now;

  const handlers = new Set<(event: MarketEvent) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  let state: ConnectionState = "disconnected";
  let started = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let failures = 0;
  let interest: string[] = [];
  const watched = new Map<string, number>();
  /** Charted pairs, least recently used first; the last one is on screen. */
  const charts = new Map<string, ChartStream>();
  const lastTickPrice = new Map<string, number>();

  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    for (const listener of [...stateListeners]) {
      try {
        listener(next);
      } catch (err) {
        console.error("[alpaca] connection listener threw", err);
      }
    }
  };

  const emit = (event: MarketEvent) => {
    for (const handler of [...handlers]) {
      try {
        handler(event);
      } catch (err) {
        console.error("[alpaca] subscriber threw", err);
      }
    }
  };

  function rememberChart(symbol: string, timeframe: StockTimeframe, base: Bar | null): void {
    const key = `${symbol}|${timeframe}`;
    const existing = charts.get(key);
    charts.delete(key);
    charts.set(key, {
      symbol,
      timeframe,
      base: base ?? existing?.base ?? null,
      fetchedAt: base ? now() : (existing?.fetchedAt ?? 0),
      refreshing: false,
      emitted: existing?.emitted ?? null,
    });
    while (charts.size > maxCharts) {
      const oldest = charts.keys().next().value;
      if (oldest === undefined) break;
      charts.delete(oldest);
    }
  }

  function pollSymbols(): string[] {
    const set = new Set<string>(interest);
    for (const symbol of watched.keys()) set.add(symbol);
    for (const stream of charts.values()) set.add(stream.symbol);
    return [...set];
  }

  function isHidden(): boolean {
    return typeof document !== "undefined" && document.visibilityState === "hidden";
  }

  function schedule(delay: number): void {
    if (!started) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, delay);
  }

  function nextDelay(): number {
    if (failures > 0) return Math.min(30_000, pollMs * 2 ** Math.min(failures, 4));
    return isHidden() ? hiddenPollMs : pollMs;
  }

  async function refreshBases(): Promise<void> {
    const t = now();
    await Promise.all(
      [...charts.values()].map(async (stream) => {
        const every = isIntraday(stream.timeframe) ? barRefresh.intraday : barRefresh.daily;
        if (stream.refreshing || t - stream.fetchedAt < every) return;
        stream.refreshing = true;
        try {
          const bars = await client.getBars({ symbol: stream.symbol, timeframe: stream.timeframe, limit: 2 });
          const newest = bars[bars.length - 1];
          if (newest && (!stream.base || newest.time >= stream.base.time)) stream.base = newest;
          stream.fetchedAt = now();
        } catch {
          // Keep the previous bar; the snapshot still moves it.
          stream.fetchedAt = now();
        } finally {
          stream.refreshing = false;
        }
      }),
    );
  }

  function emitCandles(): void {
    const t = now();
    for (const stream of charts.values()) {
      const bar = buildLiveBar(stream.timeframe, stream.base, store.get(stream.symbol), t);
      if (!bar || sameBar(bar, stream.emitted)) continue;
      stream.emitted = bar;
      emit({
        type: "candle",
        symbol: stream.symbol,
        timeframe: stream.timeframe,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        timestamp: bar.time,
      });
    }
  }

  function emitTicks(snapshots: Record<string, StockSnapshot>): void {
    for (const [symbol, snap] of Object.entries(snapshots)) {
      const trade = latestTrade(snap);
      if (!trade || lastTickPrice.get(symbol) === trade.price) continue;
      lastTickPrice.set(symbol, trade.price);
      emit({
        type: "tick",
        symbol,
        bid: trade.price,
        ask: trade.price,
        timestamp: tickTimestamp(trade, snap),
      });
    }
  }

  async function runPoll(): Promise<void> {
    const symbols = pollSymbols();
    try {
      if (symbols.length > 0) {
        const [snapshots] = await Promise.all([client.getSnapshots(symbols), refreshBases()]);
        if (!started) return;
        store.update(snapshots);
        // Candles first: the chart must hold the right forming bar before a tick lands.
        emitCandles();
        emitTicks(snapshots);
      }
      failures = 0;
      setState("connected");
    } catch (err) {
      failures += 1;
      if (failures === 1) console.warn(`[alpaca] snapshot poll failed: ${describe(err)}`);
      setState("reconnecting");
    }
  }

  function poll(): Promise<void> {
    if (!started) return Promise.resolve();
    inFlight ??= runPoll().finally(() => {
      inFlight = null;
      schedule(nextDelay());
    });
    return inFlight;
  }

  async function getSymbols(): Promise<Symbol[]> {
    const extras = (options.extraSymbols ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean);
    let list: { symbol: string; exchange: string }[];
    try {
      list = await client.getList();
    } catch (err) {
      if (extras.length === 0) throw err;
      list = [];
    }
    const symbols = [...new Set([...list.map((e) => e.symbol), ...extras])];
    const exchangeOf = new Map(list.map((e) => [e.symbol, e.exchange]));
    let assets: AssetInfo[] = [];
    try {
      assets = await client.getAssets(symbols);
    } catch (err) {
      console.warn(`[alpaca] company names unavailable: ${describe(err)}`);
    }
    const bySymbol = new Map(assets.map((a) => [a.symbol, a]));
    return symbols.map((s) => stockSymbol(s, bySymbol.get(s), exchangeOf.get(s)));
  }

  async function getCandles(request: CandleRequest): Promise<Candle[]> {
    const { symbol, timeframe, limit, fromMs, toMs } = request;
    if (!isStockTimeframe(timeframe)) throw new Error(`Unsupported timeframe "${timeframe}" for stocks`);
    const windowed = fromMs != null || toMs != null;
    let bars = await client.getBars({ symbol, timeframe, startMs: fromMs, endMs: toMs, limit });
    if (bars.length === 0 && fromMs != null && toMs != null) {
      // Overnight and weekend gaps leave intraday windows empty, and the chart
      // gives up after a few in a row. Jump to the bars before the gap instead.
      bars = await client.getBars({ symbol, timeframe, endMs: toMs, limit: GAP_FILL_LIMIT });
    }
    if (!windowed) {
      // History ends where delayed SIP does; bring its last bar up to the
      // latest polled trade (or add today's bar) so it agrees with the ticks
      // and candles that follow.
      const last = bars[bars.length - 1] ?? null;
      const live = buildLiveBar(timeframe, last, store.get(symbol), now());
      if (live && last && live !== last && live.time >= last.time) {
        bars = live.time === last.time ? [...bars.slice(0, -1), live] : [...bars, live];
      }
      rememberChart(symbol, timeframe, bars[bars.length - 1] ?? null);
      if (started && !pollSymbols().every((s) => store.get(s))) void poll();
    }
    return bars.map(toCandle);
  }

  async function getQuote(symbol: string): Promise<Quote | null> {
    let snap = store.get(symbol);
    if (!snap) {
      const fetched = await client.getSnapshots([symbol]);
      store.update(fetched);
      snap = fetched[symbol];
    }
    const trade = latestTrade(snap);
    if (!trade) return null;
    return { symbol, bid: trade.price, ask: trade.price, timestamp: tickTimestamp(trade, snap) };
  }

  const marketData: AlpacaMarketData = {
    getSymbols,
    getCandles,
    getQuote,

    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    connect() {
      if (started) return;
      started = true;
      failures = 0;
      setState("connecting");
      schedule(0);
    },

    disconnect() {
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
      lastTickPrice.clear();
      setState("disconnected");
    },

    onConnectionChange(listener) {
      stateListeners.add(listener);
      listener(state);
      return () => {
        stateListeners.delete(listener);
      };
    },

    getConnectionState: () => state,

    setSymbolInterest(symbols) {
      const next = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
      const added = next.some((s) => !interest.includes(s) && !store.get(s));
      interest = next;
      // Price new rows right away instead of on the next interval.
      if (started && added) schedule(50);
    },

    watchSymbols(symbols) {
      const list = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
      let added = false;
      for (const s of list) {
        const n = watched.get(s) ?? 0;
        if (n === 0 && !store.get(s)) added = true;
        watched.set(s, n + 1);
      }
      if (started && added) schedule(50);
      return () => {
        for (const s of list) {
          const n = (watched.get(s) ?? 1) - 1;
          if (n <= 0) watched.delete(s);
          else watched.set(s, n);
        }
      };
    },

    setActiveChart(symbol, timeframe) {
      if (!isStockTimeframe(timeframe)) return;
      rememberChart(symbol.trim().toUpperCase(), timeframe, null);
    },

    pollNow: () => poll(),
  };

  return { name: "alpaca", marketData, snapshots: store, client };
}

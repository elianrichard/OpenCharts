/** Public surface of the stock data layer. */
export {
  createAlpacaAdapter,
  stockSymbol,
  STOCK_TRADING_HOURS,
  type AlpacaAdapter,
  type AlpacaAdapterOptions,
  type AlpacaMarketData,
} from "./adapter.ts";
export {
  createStocksClient,
  stocksApi,
  StocksApiError,
  type StocksClient,
  type StocksClientOptions,
  type BarsQuery,
  type ScanStatus,
} from "./client.ts";
export {
  createSnapshotStore,
  snapshotStore,
  getSnapshot,
  getSnapshots,
  subscribeSnapshots,
  type SnapshotStore,
  type SnapshotListener,
} from "./snapshots.ts";
export { buildBook, holdingPnl, holdingsFromJournal, ODD_RATIO, type HoldingPnl } from "./holdings.ts";
export { parseJournal, parseLine, parseText, formatLine, normalizeTicker, type JournalFill } from "./journal.ts";
export { marketSession, etDateKey, ET_TIMEZONE, type MarketSession } from "./time.ts";

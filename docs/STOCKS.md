# Stock workspace (Alpaca)

A local US-stock workspace on top of the OpenCharts terminal. It shows the
trading-script scan lists (Divergence Buy, Stoch RSI 4-cross), your positions
from the Divergence Buy dashboard's journal, and a TradingView-style chart with
your strategies drawn on it.

It is **local only**: the Vite dev server talks to Alpaca with your keys, and
the page only ever talks to the dev server. Keys never reach the browser.

## Run it

```bash
VITE_ADAPTER=alpaca npm run dev      # http://localhost:5173
```

Keys are read server-side, in this order:

1. `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` in `OpenCharts/.env.local`
2. the dotenv file at `STOCKS_DOTENV` (default `../trading-script/.env`, the
   same keys the Railway bot uses)

| Variable | Default | What it is |
| --- | --- | --- |
| `STOCKS_LIST_PATH` | `../trading-script/list.txt` | The scan universe, one `EXCHANGE:TICKER` per line |
| `STOCKS_JOURNAL_PATH` | `../trading-script/dashboard/data/journal.json` | Buys and sells recorded on the Divergence Buy dashboard |
| `STOCKS_CACHE_DIR` | `.cache/stocks` | Bar cache, topped up incrementally like `backtest/data.py` |

None of these are `VITE_`-prefixed on purpose: nothing here is bundled.

## What is on screen

- **Watchlist** (right): *Your positions*, *Divergence Buy* (buy at next open,
  sell at next open, holding with sessions left), *Stoch RSI 4-cross · 1W*
  (fresh ARM / CNF), your own *Watchlist*, and the full *Scan list*. Last,
  Chg and Chg% poll Alpaca about every 5 seconds. Click the left edge of a row
  to flag it; arrow keys move through the list.
- **Details** (under the watchlist): price and session, extended-hours trade,
  volume against the 30-day average, day range, your position and P/L, and
  each scan's state. A holding Divergence Buy trade shows its exit clock: 20
  cells, one per session until the sell open.
- **Chart**: candles, hollow candles, Heikin Ashi, bars, line or area; the EMA
  ribbon (20/50/100/200); regular divergences on 10 oscillators with their
  labels; Divergence Buy entries and exits (daily); Stoch 4-cross ARM/CNF
  (weekly); Stoch RSI and the built-in oscillators in stacked panes; compare up
  to four symbols in percent; all of OpenCharts' drawing tools.
- **Under the chart**: range presets (1D … All) and the New York clock.
- **Bottom panel**: the *Strategy tester* (Divergence Buy on the charted name
  over its full daily history: net profit, win rate, profit factor, drawdown,
  equity, every trade), the two scan tables, and your positions (open and
  closed).
- **Alerts** (right rail): price alerts on any symbol, checked on every poll
  while the tab is open, with a log.
- **Layout**: 1, 2 or 4 charts.

Keys: type any letter to search a symbol, `/` for indicators, `Alt+A` for an
alert, `⌘Z` / `⇧⌘Z` to undo and redo drawings.

## Where the numbers come from

- Scans run in the dev server over `list.txt` using the TypeScript ports in
  `src/stocks/scans` (parity-tested against the Python in trading-script), on
  Alpaca SIP bars with `adjustment=all` from 2016, the same inputs as the bot.
  They are cached per trading day; the refresh button in the scan tables runs
  them again.
- Chart overlays and the strategy tester run in the browser with the same code.
- Free Alpaca plans cannot read SIP data from the last 15 minutes, so the last
  price comes from IEX trades and today's volume is 15 minutes behind.

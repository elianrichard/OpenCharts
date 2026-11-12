import { BellPlus, ExternalLink, Minus, Plus } from "lucide-react";
import type { AssetInfo, DivScanRow, Holding, StochScanRow } from "../../types.ts";
import {
  DASH,
  fmtClock,
  fmtDay,
  fmtMoney,
  fmtPct,
  fmtPrice,
  fmtQty,
  fmtSigned,
  fmtVolume,
  polarity,
} from "../format.ts";
import { useSnapshot } from "../market.ts";

/**
 * The selected symbol: price, the session, what the scans say about it and
 * the user's own position. The exit clock is this product's own element:
 * a Divergence Buy trade sells at a fixed open, 20 sessions after entry.
 */

const HOLD_BARS = 20;

function polColor(v: number | null | undefined): string {
  const p = polarity(v);
  return p > 0 ? "var(--pos)" : p < 0 ? "var(--neg)" : "var(--ink-2)";
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex h-7 items-center justify-between gap-3 text-[13px]" title={hint}>
      <span className="text-[var(--mute)]">{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}

/** 20 cells, one per session of the hold; filled cells are sessions already held. */
export function ExitClock({ held, left }: { held: number; left: number }) {
  const total = Math.max(HOLD_BARS, held + left);
  return (
    <div className="mt-2">
      <div className="flex gap-[2px]" role="img" aria-label={`${held} of ${total} sessions held, ${left} to go`}>
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className="h-2 flex-1 rounded-[1px]"
            style={{ background: i < held ? "var(--line-accent)" : "var(--raised)" }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-[var(--mute)]">
        <span>Entry open</span>
        <span>
          Sells at the open in <span className="num text-[var(--ink)]">{left}</span> session{left === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}

function DivSignal({ row }: { row: DivScanRow }) {
  if (!row.state) {
    return (
      <p className="text-[12px] text-[var(--mute)]">
        No signal. Today: <span className="num">{row.divSum}</span> divergences in 4 bars, IBS{" "}
        <span className="num">{row.ibs.toFixed(2)}</span>.
      </p>
    );
  }
  if (row.state === "NEW") {
    return (
      <div className="text-[13px]">
        <div className="flex items-center gap-2">
          <span className="pill pill-pos">Buy at next open</span>
          <span className="num text-[var(--mute)]">{fmtDay(row.signalDate)}</span>
        </div>
        <p className="mt-1 text-[12px] text-[var(--mute)]">
          <span className="num text-[var(--ink)]">{row.divSum}</span> bullish divergences in 4 bars, close in
          the bottom of its range (IBS <span className="num">{row.ibs.toFixed(2)}</span>).
        </p>
      </div>
    );
  }
  return (
    <div className="text-[13px]">
      <div className="flex items-center gap-2">
        <span className={row.state === "EXIT" ? "pill pill-neg" : "pill pill-neutral"}>
          {row.state === "EXIT" ? "Sell at next open" : "Holding"}
        </span>
        <span className="num text-[var(--mute)]">since {fmtDay(row.entryDate)}</span>
      </div>
      <div className="mt-1 flex justify-between text-[12px]">
        <span className="text-[var(--mute)]">
          Bought <span className="num text-[var(--ink)]">{fmtPrice(row.entry)}</span>
        </span>
        <span className="num" style={{ color: polColor(row.pnlPct) }}>
          {fmtPct(row.pnlPct, 1)}
        </span>
      </div>
      {row.held != null && row.left != null && <ExitClock held={row.held} left={row.left} />}
    </div>
  );
}

function StochSignal({ row }: { row: StochScanRow }) {
  if (!row.stage || !row.fresh || row.stage === "FAILED") {
    return <p className="text-[12px] text-[var(--mute)]">No fresh weekly setup.</p>;
  }
  return (
    <div className="text-[13px]">
      <div className="flex items-center gap-2">
        <span className={row.stage === "CONFIRMED" ? "pill pill-pos" : "pill pill-warn"}>
          {row.stage === "CONFIRMED" ? "Confirmed" : "Armed"}
        </span>
        <span className="num text-[var(--mute)]">
          {fmtDay(row.signalDate)} · {row.daysSince ?? DASH}d ago
        </span>
      </div>
      <div className="mt-1 grid grid-cols-3 gap-2 text-[12px]">
        <span className="text-[var(--mute)]">
          Entry <span className="num block text-[var(--ink)]">{fmtPrice(row.entry)}</span>
        </span>
        <span className="text-[var(--mute)]">
          Stop <span className="num block text-[var(--ink)]">{fmtPrice(row.sl)}</span>
        </span>
        <span className="text-[var(--mute)]">
          Target <span className="num block text-[var(--ink)]">{fmtPrice(row.tp)}</span>
        </span>
      </div>
    </div>
  );
}

export function SymbolDetails({
  symbol,
  asset,
  exchange,
  holding,
  div,
  stoch,
  inWatchlist,
  onToggleWatchlist,
  onAddAlert,
  noData,
}: {
  symbol: string;
  asset: AssetInfo | undefined;
  exchange: string | undefined;
  holding: Holding | undefined;
  div: DivScanRow | undefined;
  stoch: StochScanRow | undefined;
  inWatchlist: boolean;
  onToggleWatchlist: () => void;
  onAddAlert: () => void;
  /** Alpaca returned no bars for this ticker. */
  noData?: boolean;
}) {
  const snap = useSnapshot(symbol);
  const last = snap?.last ?? null;
  const exch = exchange ?? asset?.exchange;
  const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(exch ? `${exch}:${symbol}` : symbol)}`;

  const volRatio = snap?.volume != null && snap.avgVolume30 ? snap.volume / snap.avgVolume30 : null;
  const rangePos =
    snap?.low != null && snap.high != null && last != null && snap.high > snap.low
      ? (last - snap.low) / (snap.high - snap.low)
      : null;

  const posValue = holding && last != null ? holding.shares * last : null;
  const posPnl = holding?.avgPrice != null && last != null ? (last - holding.avgPrice) * holding.shares : null;
  const posPnlPct = holding?.avgPrice != null && last != null ? (last / holding.avgPrice - 1) * 100 : null;

  return (
    <div className="scroll-thin min-h-0 overflow-y-auto border-t border-[var(--edge)] px-4 pb-4 pt-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[16px] font-semibold">{symbol}</div>
          <div className="truncate text-[12px] text-[var(--mute)]">
            {asset?.name && asset.name !== symbol ? asset.name : "US equity"}
            {exch ? ` · ${exch}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <button type="button" className="tbtn !h-7 !px-1.5" onClick={onAddAlert} aria-label={`Create alert on ${symbol}`} title="Create alert">
            <BellPlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="tbtn !h-7 !px-1.5"
            onClick={onToggleWatchlist}
            aria-label={inWatchlist ? `Remove ${symbol} from watchlist` : `Add ${symbol} to watchlist`}
            title={inWatchlist ? "Remove from watchlist" : "Add to watchlist"}
          >
            {inWatchlist ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          </button>
          <a className="tbtn !h-7 !px-1.5" href={tvUrl} target="_blank" rel="noreferrer" aria-label="Open on TradingView" title="Open on TradingView">
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      </div>

      <div className="mt-3 flex items-baseline gap-2">
        <span className="num text-[26px] font-semibold leading-none">{fmtPrice(last)}</span>
        <span className="text-[12px] text-[var(--mute)]">USD</span>
        <span className="num text-[14px]" style={{ color: polColor(snap?.change) }}>
          {fmtSigned(snap?.change)} {fmtPct(snap?.changePct)}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-[var(--mute)]">
        {snap?.lastTime
          ? `Last trade ${fmtClock(snap.lastTime)} · IEX`
          : noData
            ? `Alpaca has no data for ${symbol}. Check the ticker.`
            : "Waiting for the first quote"}
      </div>
      {snap?.extended && (
        <div className="mt-2 flex items-baseline gap-2 text-[13px]">
          <span className="text-[var(--warn)]">{snap.extended.session === "pre" ? "Pre-market" : "After hours"}</span>
          <span className="num">{fmtPrice(snap.extended.price)}</span>
          <span className="num" style={{ color: polColor(snap.extended.change) }}>
            {fmtSigned(snap.extended.change)} {fmtPct(snap.extended.changePct)}
          </span>
        </div>
      )}

      <div className="mt-3">
        <Row
          label="Volume"
          value={`${fmtVolume(snap?.volume)}${volRatio != null ? ` · ${volRatio.toFixed(2)}× avg` : ""}`}
          hint="Today's consolidated volume (15-minute delay) against the 30-day average"
        />
        {volRatio != null && (
          <div className="mb-1 h-1 w-full rounded bg-[var(--raised)]" aria-hidden>
            <div className="h-1 rounded bg-[var(--ink-2)]" style={{ width: `${Math.min(100, volRatio * 50)}%` }} />
          </div>
        )}
        <Row label="Avg volume 30D" value={fmtVolume(snap?.avgVolume30)} />
        <Row label="Day range" value={`${fmtPrice(snap?.low)} – ${fmtPrice(snap?.high)}`} />
        {rangePos != null && (
          <div className="relative mb-1 h-1 w-full rounded bg-[var(--raised)]" aria-hidden>
            <span className="absolute top-1/2 h-2.5 w-[2px] -translate-y-1/2 bg-[var(--ink)]" style={{ left: `${rangePos * 100}%` }} />
          </div>
        )}
        <Row label="Prev close" value={fmtPrice(snap?.prevClose)} />
      </div>

      <h3 className="mb-1.5 mt-4 text-[12px] font-medium text-[var(--mute)]">Your position</h3>
      {holding ? (
        <div>
          <Row label="Shares" value={fmtQty(holding.shares)} />
          <Row label="Avg cost" value={fmtPrice(holding.avgPrice)} />
          <Row label="Value" value={fmtMoney(posValue)} />
          <div className="flex h-7 items-center justify-between text-[13px]">
            <span className="text-[var(--mute)]">P/L</span>
            <span className="num" style={{ color: polColor(posPnl) }}>
              {fmtMoney(posPnl, true)} · {fmtPct(posPnlPct, 1)}
            </span>
          </div>
          <Row label="Since" value={holding.since} />
          {holding.partial && (
            <p className="mt-1 text-[11px] text-[var(--mute)]">
              Some fills lack shares or price; P/L covers the rest.
            </p>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-[var(--mute)]">Not in your journal.</p>
      )}

      <h3 className="mb-1.5 mt-4 text-[12px] font-medium text-[var(--mute)]">Divergence Buy · 1D</h3>
      {div ? <DivSignal row={div} /> : <p className="text-[12px] text-[var(--mute)]">Not in the scan list.</p>}

      <h3 className="mb-1.5 mt-4 text-[12px] font-medium text-[var(--mute)]">Stoch RSI 4-cross · 1W</h3>
      {stoch ? <StochSignal row={stoch} /> : <p className="text-[12px] text-[var(--mute)]">Not in the scan list.</p>}
    </div>
  );
}

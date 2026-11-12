import { useState } from "react";
import type { StrategyResult } from "../../types.ts";
import { DASH, fmtDay, fmtMoney, fmtPct, fmtPrice, fmtQty, fmtRate, polarity } from "../format.ts";
import { EquityChart } from "./EquityChart.tsx";

/**
 * Divergence Buy on the charted symbol over its full daily history (Alpaca
 * SIP from 2016, the same span the scan uses), one position at a time,
 * entry at the next open, exit at the open 20 bars later.
 */

function pol(v: number | null | undefined) {
  const p = polarity(v);
  return p > 0 ? "var(--pos)" : p < 0 ? "var(--neg)" : "var(--ink)";
}

function Metric({
  label,
  value,
  sub,
  color,
  big,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  big?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[12px] text-[var(--mute)]">{label}</div>
      <div className={`num truncate ${big ? "text-[20px]" : "text-[15px]"}`} style={{ color }}>
        {value}
      </div>
      {sub && <div className="num text-[11px] leading-4 text-[var(--mute)]">{sub}</div>}
    </div>
  );
}

export function StrategyTester({
  symbol,
  result,
  loading,
  noData,
  error,
  rangeLabel,
  onJumpTo,
}: {
  symbol: string;
  result: StrategyResult | null;
  loading: boolean;
  /** History came back too short to trade (unknown ticker, fresh listing). */
  noData?: boolean;
  error: string | null;
  rangeLabel: string;
  onJumpTo: (time: number) => void;
}) {
  const [view, setView] = useState<"overview" | "trades">("overview");

  if (error) {
    return <p className="p-4 text-[13px] text-[var(--neg)]">Can't load {symbol}'s daily history: {error}</p>;
  }
  if (noData) {
    return (
      <p className="p-4 text-[13px] text-[var(--mute)]">
        Alpaca has too little daily history for {symbol} to test the strategy. Check the ticker.
      </p>
    );
  }
  if (loading || !result) {
    return <p className="p-4 text-[13px] text-[var(--mute)]">Running Divergence Buy on {symbol}'s daily history…</p>;
  }
  const s = result.stats;
  const trades = [...result.trades].reverse();
  const open = result.trades.find((t) => t.open);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-4 border-b border-[var(--rule)] px-4 text-[13px]">
        {(["overview", "trades"] as const).map((v) => (
          <button
            key={v}
            type="button"
            className="sel h-full shrink-0 whitespace-nowrap text-[var(--ink-2)] hover:text-[var(--ink)] data-[on=true]:text-[var(--ink)]"
            data-on={view === v}
            onClick={() => setView(v)}
          >
            {v === "overview" ? "Overview" : `List of trades · ${result.trades.length}`}
          </button>
        ))}
        <span className="ml-auto truncate text-[12px] text-[var(--mute)]">
          {symbol} · 1D · {rangeLabel} · {fmtMoney(s.initialCapital).replace(".00", "")} initial capital
        </span>
      </div>

      {view === "overview" ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pt-3">
          <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 xl:grid-cols-[minmax(150px,1.4fr)_repeat(6,minmax(0,1fr))]">
            <Metric
              big
              label="Net profit"
              value={fmtMoney(s.netProfit, true)}
              sub={`${fmtPct(s.netProfitPct)} · buy & hold ${fmtPct(s.buyHoldPct, 1)}`}
              color={pol(s.netProfit)}
            />
            <Metric label="Closed trades" value={String(s.closedTrades)} sub={`${s.winningTrades} won · ${s.losingTrades} lost`} />
            <Metric label="Percent profitable" value={fmtRate(s.winRate)} />
            <Metric
              label="Profit factor"
              value={s.closedTrades === 0 ? "–" : Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "No losses"}
            />
            <Metric label="Max drawdown" value={fmtMoney(-Math.abs(s.maxDrawdown))} sub={fmtPct(-Math.abs(s.maxDrawdownPct))} />
            <Metric label="Avg trade" value={fmtPct(s.avgTradePct)} sub={`win ${fmtPct(s.avgWinPct, 1)} · loss ${fmtPct(s.avgLossPct, 1)}`} />
            <Metric label="Avg bars in trade" value={s.avgBars.toFixed(1)} />
          </div>
          {open && (
            <p className="mt-2 shrink-0 text-[12px] text-[var(--mute)]">
              Open trade since <span className="num text-[var(--ink)]">{fmtDay(open.entryTime)}</span> at{" "}
              <span className="num text-[var(--ink)]">{fmtPrice(open.entryPrice)}</span>,{" "}
              <span className="num" style={{ color: pol(open.pnlPct) }}>
                {fmtPct(open.pnlPct)}
              </span>{" "}
              so far. Not counted in the closed-trade figures.
            </p>
          )}
          <div className="mt-2 min-h-0 flex-1">
            <EquityChart points={s.equity} baseline={s.initialCapital} />
          </div>
        </div>
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-auto">
          {trades.length === 0 ? (
            <p className="p-4 text-[13px] text-[var(--mute)]">No trades on {symbol} since 2016.</p>
          ) : (
            <table className="w-full min-w-[760px] border-collapse text-[13px]">
              <thead className="sticky top-0 bg-[var(--surface)]">
                <tr className="h-8 text-left text-[11px] text-[var(--mute)]">
                  <th className="px-4 font-normal">#</th>
                  <th className="font-normal">Signal</th>
                  <th className="font-normal">Entry</th>
                  <th className="text-right font-normal">Price</th>
                  <th className="pl-6 font-normal">Exit</th>
                  <th className="text-right font-normal">Price</th>
                  <th className="text-right font-normal">Shares</th>
                  <th className="text-right font-normal">Bars</th>
                  <th className="text-right font-normal">P/L</th>
                  <th className="text-right font-normal">P/L %</th>
                  <th className="text-right font-normal">Run-up</th>
                  <th className="px-4 text-right font-normal">Drawdown</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr
                    key={t.id}
                    className="row-hover h-9 cursor-pointer border-t border-[var(--rule)]"
                    onClick={() => onJumpTo(t.entryTime)}
                    title="Show on chart"
                  >
                    <td className="num px-4 text-[var(--mute)]">{t.id}</td>
                    <td className="num text-[var(--ink-2)]">
                      {fmtDay(t.signalTime)} <span className="text-[var(--mute)]">· {t.divSum} div</span>
                    </td>
                    <td className="num">{fmtDay(t.entryTime)}</td>
                    <td className="num text-right">{fmtPrice(t.entryPrice)}</td>
                    <td className="num pl-6">{t.open ? <span className="pill pill-neutral">Open</span> : fmtDay(t.exitTime)}</td>
                    <td className="num text-right">{t.open ? fmtPrice(t.markPrice) : fmtPrice(t.exitPrice)}</td>
                    <td className="num text-right text-[var(--ink-2)]">{fmtQty(t.qty)}</td>
                    <td className="num text-right text-[var(--ink-2)]">{t.bars}</td>
                    <td className="num text-right">{fmtMoney(t.pnl, true)}</td>
                    <td className="num text-right" style={{ color: pol(t.pnlPct) }}>
                      {fmtPct(t.pnlPct)}
                    </td>
                    <td className="num text-right text-[var(--ink-2)]">{fmtPct(t.runUpPct)}</td>
                    <td className="num px-4 text-right text-[var(--ink-2)]">
                      {t.drawdownPct ? fmtPct(-Math.abs(t.drawdownPct)) : DASH}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

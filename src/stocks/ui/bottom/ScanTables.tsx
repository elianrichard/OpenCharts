import { RefreshCw } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { DivScanRow, HoldingsReport, ScanReport, StochScanRow } from "../../types.ts";
import {
  DASH,
  fmtDay,
  fmtMoney,
  fmtPct,
  fmtPrice,
  fmtQty,
  polarity,
} from "../format.ts";
import { getSnapshot, useSnapshotVersion } from "../market.ts";
import type { ScanStatus } from "../queries.ts";

function polColor(v: number | null | undefined) {
  const p = polarity(v);
  return p > 0 ? "var(--pos)" : p < 0 ? "var(--neg)" : "var(--ink)";
}

function Th({ children, right, first }: { children: ReactNode; right?: boolean; first?: boolean }) {
  return (
    <th className={`font-normal ${right ? "text-right" : "text-left"} ${first ? "pl-4" : ""} last:pr-4`}>
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  first,
  dim,
  color,
}: {
  children: ReactNode;
  right?: boolean;
  first?: boolean;
  dim?: boolean;
  color?: string;
}) {
  return (
    <td
      className={`num ${right ? "text-right" : ""} ${first ? "pl-4 font-semibold" : ""} last:pr-4`}
      style={{ color: color ?? (dim ? "var(--ink-2)" : undefined) }}
    >
      {children}
    </td>
  );
}

function FilterTabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex h-full items-center gap-4">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className="sel h-full text-[13px] text-[var(--ink-2)] hover:text-[var(--ink)] data-[on=true]:text-[var(--ink)]"
          data-on={value === o.id}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ScanHeaderStatus({
  report,
  status,
  onRefresh,
}: {
  report: ScanReport | undefined;
  status: ScanStatus | undefined;
  onRefresh: () => void;
}) {
  const running = status?.running;
  return (
    <div className="ml-auto flex items-center gap-2 text-[12px] text-[var(--mute)]">
      {running ? (
        <span className="num">
          Scanning {status!.done}/{status!.total}
        </span>
      ) : report ? (
        <span>
          Closed bars to <span className="num text-[var(--ink-2)]">{fmtDay(report.asOf)}</span> ·{" "}
          <span className="num">{report.universe.length}</span> names
          {report.failures.length > 0 && (
            <span className="text-[var(--warn)]" title={report.failures.map((f) => `${f.symbol} ${f.scan}: ${f.error}`).join("\n")}>
              {" "}
              · {report.failures.length} failed
            </span>
          )}
        </span>
      ) : null}
      <button type="button" className="tbtn !h-7 !px-1.5" onClick={onRefresh} disabled={running} aria-label="Run the scans again" title="Run the scans again">
        <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
      </button>
    </div>
  );
}

type DivFilter = "action" | "NEW" | "EXIT" | "HOLD" | "all";

export function DivBuyTable({
  rows,
  held,
  onSelect,
  header,
}: {
  rows: DivScanRow[];
  held: Set<string>;
  onSelect: (s: string) => void;
  header: ReactNode;
}) {
  const [filter, setFilter] = useState<DivFilter>("action");
  const counts = useMemo(() => {
    const c = { NEW: 0, EXIT: 0, HOLD: 0 };
    for (const r of rows) if (r.state) c[r.state]++;
    return c;
  }, [rows]);
  const shown = useMemo(() => {
    const order = { NEW: 0, EXIT: 1, HOLD: 2 } as const;
    return rows
      .filter((r) =>
        filter === "all" ? true : filter === "action" ? r.state != null : r.state === filter,
      )
      .sort(
        (a, b) =>
          (a.state ? order[a.state] : 3) - (b.state ? order[b.state] : 3) ||
          (a.state === "NEW" ? b.divSum - a.divSum : (a.left ?? 99) - (b.left ?? 99)) ||
          a.symbol.localeCompare(b.symbol),
      );
  }, [rows, filter]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-4 border-b border-[var(--rule)] px-4">
        <FilterTabs
          value={filter}
          onChange={setFilter}
          options={[
            { id: "action", label: `Signals · ${counts.NEW + counts.EXIT + counts.HOLD}` },
            { id: "NEW", label: `Buy at open · ${counts.NEW}` },
            { id: "EXIT", label: `Sell at open · ${counts.EXIT}` },
            { id: "HOLD", label: `Holding · ${counts.HOLD}` },
            { id: "all", label: `All · ${rows.length}` },
          ]}
        />
        {header}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-auto">
        {shown.length === 0 ? (
          <p className="p-4 text-[13px] text-[var(--mute)]">
            {rows.length === 0 ? "No scan yet. It runs on the first load and once per trading day." : "Nothing here today."}
          </p>
        ) : (
          <table className="w-full min-w-[820px] border-collapse text-[13px]">
            <thead className="sticky top-0 bg-[var(--surface)]">
              <tr className="h-8 text-[11px] text-[var(--mute)]">
                <Th first>Symbol</Th>
                <Th>State</Th>
                <Th>Signal</Th>
                <Th>Entry</Th>
                <Th right>Bought at</Th>
                <Th right>Close</Th>
                <Th right>P/L %</Th>
                <Th right>Sessions left</Th>
                <Th right>Div (4 bars)</Th>
                <Th right>IBS</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.symbol} className="row-hover h-9 cursor-pointer border-t border-[var(--rule)]" onClick={() => onSelect(r.symbol)}>
                  <Td first>
                    {r.symbol}
                    {held.has(r.symbol) && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--ink-2)] align-middle" title="You hold this" />}
                  </Td>
                  <td>
                    {r.state === "NEW" ? (
                      <span className="pill pill-pos">Buy at open</span>
                    ) : r.state === "EXIT" ? (
                      <span className="pill pill-neg">Sell at open</span>
                    ) : r.state === "HOLD" ? (
                      <span className="pill pill-neutral">Holding</span>
                    ) : (
                      <span className="text-[var(--mute)]">{DASH}</span>
                    )}
                  </td>
                  <Td dim>{fmtDay(r.signalDate)}</Td>
                  <Td dim>{fmtDay(r.entryDate)}</Td>
                  <Td right>{fmtPrice(r.entry)}</Td>
                  <Td right>{fmtPrice(r.price)}</Td>
                  <Td right color={polColor(r.pnlPct)}>{fmtPct(r.pnlPct, 1)}</Td>
                  <Td right dim>{r.left ?? DASH}</Td>
                  <Td right dim>{r.divSum}</Td>
                  <Td right dim>{r.ibs.toFixed(2)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

type StochFilter = "fresh" | "all";

export function StochTable({
  rows,
  held,
  onSelect,
  header,
}: {
  rows: StochScanRow[];
  held: Set<string>;
  onSelect: (s: string) => void;
  header: ReactNode;
}) {
  const [filter, setFilter] = useState<StochFilter>("fresh");
  const fresh = rows.filter((r) => r.fresh && (r.stage === "ARMED" || r.stage === "CONFIRMED"));
  const shown = (filter === "fresh" ? fresh : rows.filter((r) => r.stage)).sort(
    (a, b) =>
      (a.stage === "CONFIRMED" ? 0 : a.stage === "ARMED" ? 1 : 2) -
        (b.stage === "CONFIRMED" ? 0 : b.stage === "ARMED" ? 1 : 2) ||
      (a.daysSince ?? 999) - (b.daysSince ?? 999),
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-4 border-b border-[var(--rule)] px-4">
        <FilterTabs
          value={filter}
          onChange={setFilter}
          options={[
            { id: "fresh", label: `Fresh setups · ${fresh.length}` },
            { id: "all", label: `Latest event · ${rows.filter((r) => r.stage).length}` },
          ]}
        />
        <span className="text-[12px] text-[var(--mute)]">Weekly, closed bars · weak edge, low confidence</span>
        {header}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-auto">
        {shown.length === 0 ? (
          <p className="p-4 text-[13px] text-[var(--mute)]">No fresh weekly 4-cross setups.</p>
        ) : (
          <table className="w-full min-w-[760px] border-collapse text-[13px]">
            <thead className="sticky top-0 bg-[var(--surface)]">
              <tr className="h-8 text-[11px] text-[var(--mute)]">
                <Th first>Symbol</Th>
                <Th>Stage</Th>
                <Th>Signal</Th>
                <Th right>Days ago</Th>
                <Th right>Entry</Th>
                <Th right>Stop (1.5 ATR)</Th>
                <Th right>Target (3 ATR)</Th>
                <Th right>Close</Th>
                <Th right>Crosses K/D</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.symbol} className="row-hover h-9 cursor-pointer border-t border-[var(--rule)]" onClick={() => onSelect(r.symbol)}>
                  <Td first>
                    {r.symbol}
                    {held.has(r.symbol) && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--ink-2)] align-middle" title="You hold this" />}
                  </Td>
                  <td>
                    {r.stage === "CONFIRMED" ? (
                      <span className="pill pill-pos">Confirmed</span>
                    ) : r.stage === "ARMED" ? (
                      <span className="pill pill-warn">Armed</span>
                    ) : (
                      <span className="pill pill-neutral">Failed</span>
                    )}
                    {!r.fresh && <span className="ml-1.5 text-[11px] text-[var(--mute)]">stale</span>}
                  </td>
                  <Td dim>{fmtDay(r.signalDate)}</Td>
                  <Td right dim>{r.daysSince ?? DASH}</Td>
                  <Td right>{fmtPrice(r.entry)}</Td>
                  <Td right>{fmtPrice(r.sl)}</Td>
                  <Td right>{fmtPrice(r.tp)}</Td>
                  <Td right>{fmtPrice(r.price)}</Td>
                  <Td right dim>{r.crosses ? r.crosses.map((c) => c.toFixed(0)).join(" › ") : DASH}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function HoldingsTable({
  report,
  loading,
  error,
  onSelect,
  scanSymbols,
}: {
  report: HoldingsReport | undefined;
  loading: boolean;
  error: string | null;
  onSelect: (s: string) => void;
  scanSymbols: Set<string>;
}) {
  useSnapshotVersion();
  const [view, setView] = useState<"open" | "closed">("open");
  if (error) return <p className="p-4 text-[13px] text-[var(--neg)]">Can't read the journal: {error}</p>;
  if (loading || !report) return <p className="p-4 text-[13px] text-[var(--mute)]">Reading the journal…</p>;

  const rows = report.open.map((h) => {
    const last = getSnapshot(h.symbol)?.last ?? null;
    const odd = h.avgPrice != null && last != null && (last / h.avgPrice > 3 || last / h.avgPrice < 1 / 3);
    const pnl = h.avgPrice != null && last != null && !odd ? (last - h.avgPrice) * h.shares : null;
    const pct = h.avgPrice != null && last != null && !odd ? (last / h.avgPrice - 1) * 100 : null;
    return { h, last, pnl, pct, odd };
  });
  // Totals cover rows with both shares and an average price, as on the dashboard.
  const priced = rows.filter((r) => r.pnl != null && r.h.avgPrice != null);
  const totCost = priced.reduce((sum, r) => sum + r.h.avgPrice! * r.h.shares, 0);
  const totPnl = priced.reduce((sum, r) => sum + r.pnl!, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-4 border-b border-[var(--rule)] px-4">
        <FilterTabs
          value={view}
          onChange={setView}
          options={[
            { id: "open", label: `Open · ${report.open.length}` },
            { id: "closed", label: `Closed · ${report.closed.length}` },
          ]}
        />
        {view === "open" && totCost > 0 && (
          <span className="ml-auto text-[12px] text-[var(--mute)]">
            Unrealized{" "}
            <span className="num" style={{ color: polColor(totPnl) }}>
              {fmtMoney(totPnl, true)} · {fmtPct((totPnl / totCost) * 100, 1)}
            </span>{" "}
            on <span className="num text-[var(--ink-2)]">{fmtMoney(totCost)}</span> cost
          </span>
        )}
      </div>
      {report.warnings.length > 0 && (
        <p className="border-b border-[var(--rule)] px-4 py-1.5 text-[12px] text-[var(--warn)]">
          {report.warnings.length} journal line{report.warnings.length === 1 ? "" : "s"} skipped: {report.warnings.slice(0, 2).join(" · ")}
        </p>
      )}
      <div className="scroll-thin min-h-0 flex-1 overflow-auto">
        {view === "open" ? (
          rows.length === 0 ? (
            <p className="p-4 text-[13px] text-[var(--mute)]">
              No open positions. Record buys on the Divergence Buy dashboard or send "buy AVGO 10 @ 334.19" to the bot.
            </p>
          ) : (
            <table className="w-full min-w-[720px] border-collapse text-[13px]">
              <thead className="sticky top-0 bg-[var(--surface)]">
                <tr className="h-8 text-[11px] text-[var(--mute)]">
                  <Th first>Symbol</Th>
                  <Th right>Shares</Th>
                  <Th right>Avg cost</Th>
                  <Th right>Last</Th>
                  <Th right>Value</Th>
                  <Th right>P/L</Th>
                  <Th right>P/L %</Th>
                  <Th>Since</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ h, last, pnl, pct, odd }) => (
                  <tr key={h.symbol} className="row-hover h-9 cursor-pointer border-t border-[var(--rule)]" onClick={() => onSelect(h.symbol)}>
                    <Td first>
                      {h.symbol}
                      {!scanSymbols.has(h.symbol) && (
                        <span className="ml-1.5 text-[11px] font-normal text-[var(--mute)]" title="Not in list.txt, so the scans don't cover it">
                          not scanned
                        </span>
                      )}
                    </Td>
                    <Td right>{fmtQty(h.shares)}{h.partial ? "+" : ""}</Td>
                    <Td right>{fmtPrice(h.avgPrice)}</Td>
                    <Td right>{fmtPrice(last)}</Td>
                    <Td right dim>{last != null ? fmtMoney(last * h.shares) : DASH}</Td>
                    <Td right color={polColor(pnl)}>
                      {odd ? <span title="Last price is over 3× off your average: a split, a non-US ticker or a typo">check</span> : fmtMoney(pnl, true)}
                    </Td>
                    <Td right color={polColor(pct)}>{odd ? DASH : fmtPct(pct, 1)}</Td>
                    <Td dim>{h.since}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : report.closed.length === 0 ? (
          <p className="p-4 text-[13px] text-[var(--mute)]">No closed trades in the journal.</p>
        ) : (
          <table className="w-full min-w-[720px] border-collapse text-[13px]">
            <thead className="sticky top-0 bg-[var(--surface)]">
              <tr className="h-8 text-[11px] text-[var(--mute)]">
                <Th first>Symbol</Th>
                <Th>Opened</Th>
                <Th>Closed</Th>
                <Th right>Shares</Th>
                <Th right>Avg entry</Th>
                <Th right>Avg exit</Th>
                <Th right>Realized</Th>
                <Th right>Realized %</Th>
              </tr>
            </thead>
            <tbody>
              {[...report.closed].reverse().map((c, i) => (
                <tr key={`${c.symbol}-${c.closedOn}-${i}`} className="row-hover h-9 cursor-pointer border-t border-[var(--rule)]" onClick={() => onSelect(c.symbol)}>
                  <Td first>{c.symbol}</Td>
                  <Td dim>{c.openedOn}</Td>
                  <Td dim>{c.closedOn}</Td>
                  <Td right>{fmtQty(c.shares)}</Td>
                  <Td right>{fmtPrice(c.avgEntry)}</Td>
                  <Td right>{fmtPrice(c.avgExit)}</Td>
                  <Td right color={polColor(c.realized)}>{fmtMoney(c.realized, true)}</Td>
                  <Td right color={polColor(c.realizedPct)}>{fmtPct(c.realizedPct, 1)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

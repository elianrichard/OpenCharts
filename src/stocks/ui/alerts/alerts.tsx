import { Bell, BellOff, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "../../../services/toast.ts";
import { fmtClock, fmtPrice } from "../format.ts";
import { isArmed, useStocksUi, type PriceAlert } from "../store.ts";
import { describe } from "./alertEngine.ts";

/** The alert dialog and the alerts list. Firing lives in alertEngine.ts. */

export function AlertDialog({
  symbol,
  defaultPrice,
  onClose,
}: {
  symbol: string;
  defaultPrice: number | null;
  onClose: () => void;
}) {
  const addAlert = useStocksUi((s) => s.addAlert);
  const [condition, setCondition] = useState<PriceAlert["condition"]>("crossing");
  const [price, setPrice] = useState(defaultPrice != null ? defaultPrice.toFixed(2) : "");
  const [note, setNote] = useState("");
  const [repeat, setRepeat] = useState(false);
  const value = Number(price);
  const valid = price.trim() !== "" && Number.isFinite(value) && value > 0;

  const submit = () => {
    if (!valid) return;
    addAlert({ symbol, condition, price: value, note: note.trim(), repeat });
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    toast.success("Alert created", describe({ symbol, condition, price: value }));
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]" onMouseDown={onClose}>
      <form
        role="dialog"
        aria-label={`Create alert on ${symbol}`}
        className="menu w-full max-w-[380px] !p-0"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex h-11 items-center justify-between border-b border-[var(--edge)] px-4">
          <h2 className="text-[15px] font-semibold">Create alert on {symbol}</h2>
          <button type="button" className="tbtn !h-7 !px-1.5" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <label className="block">
            <span className="mb-1 block text-[12px] text-[var(--mute)]">Condition</span>
            <div className="flex gap-4">
              {(["crossing", "above", "below"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  className="sel h-8 text-[13px] text-[var(--ink-2)] data-[on=true]:text-[var(--ink)]"
                  data-on={condition === c}
                  onClick={() => setCondition(c)}
                >
                  {c === "crossing" ? "Crossing" : c === "above" ? "Crossing up" : "Crossing down"}
                </button>
              ))}
            </div>
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-[var(--mute)]">Price</span>
            <input
              autoFocus
              inputMode="decimal"
              className="field num w-full"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              aria-invalid={!valid}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-[var(--mute)]">Note (optional)</span>
            <input className="field w-full" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Breaks the 20-day high" />
          </label>
          <label className="flex items-center gap-2 text-[13px] text-[var(--ink-2)]">
            <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
            Every time (stays on after it fires)
          </label>
          <p className="text-[11px] text-[var(--mute)]">
            Checked while this tab is open, on every price poll (about every 5 seconds).
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--edge)] p-3">
          <button type="button" className="tbtn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid}
            className="tbtn !bg-[var(--line-accent)] !text-white disabled:opacity-40"
          >
            Create alert
          </button>
        </div>
      </form>
    </div>
  );
}

export function AlertsList({ onSelect }: { onSelect: (s: string) => void }) {
  const alerts = useStocksUi((s) => s.alerts);
  const log = useStocksUi((s) => s.alertLog);
  const updateAlert = useStocksUi((s) => s.updateAlert);
  const removeAlert = useStocksUi((s) => s.removeAlert);
  const clearLog = useStocksUi((s) => s.clearAlertLog);
  const [view, setView] = useState<"alerts" | "log">("alerts");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-4 px-3">
        <h2 className="text-[14px] font-semibold">Alerts</h2>
        {(["alerts", "log"] as const).map((v) => (
          <button
            key={v}
            type="button"
            className="sel h-full text-[13px] text-[var(--ink-2)] data-[on=true]:text-[var(--ink)]"
            data-on={view === v}
            onClick={() => setView(v)}
          >
            {v === "alerts" ? `Active · ${alerts.filter(isArmed).length}` : `Log · ${log.length}`}
          </button>
        ))}
        {view === "log" && log.length > 0 && (
          <button type="button" className="tbtn ml-auto !h-7 text-[12px]" onClick={clearLog}>
            Clear
          </button>
        )}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto border-t border-[var(--rule)]">
        {view === "alerts" ? (
          alerts.length === 0 ? (
            <p className="p-4 text-[12px] text-[var(--mute)]">
              No alerts. Use Alert in the toolbar, or right-click the chart at a price.
            </p>
          ) : (
            alerts.map((a) => {
              const armed = isArmed(a);
              return (
                <div key={a.id} className="row-hover group flex min-h-11 items-center gap-2 border-b border-[var(--rule)] px-3 py-1.5">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(a.symbol)}>
                    <div className="text-[13px]">
                      <span className="font-semibold">{a.symbol}</span>{" "}
                      <span className="text-[var(--ink-2)]">
                        {a.condition === "above" ? "crossing up" : a.condition === "below" ? "crossing down" : "crossing"}
                      </span>{" "}
                      <span className="num">{fmtPrice(a.price)}</span>
                    </div>
                    <div className="truncate text-[11px] text-[var(--mute)]">
                      {a.paused
                        ? "Paused"
                        : armed
                          ? a.repeat
                            ? "Every time"
                            : "Once"
                          : `Fired ${fmtClock(a.triggeredAt)}`}
                      {a.note ? ` · ${a.note}` : ""}
                    </div>
                  </button>
                  <button
                    type="button"
                    className="tbtn !h-7 !px-1.5"
                    onClick={() =>
                      updateAlert(a.id, armed ? { paused: true } : { paused: false, triggeredAt: null })
                    }
                    aria-label={armed ? "Pause alert" : "Re-arm alert"}
                    title={armed ? "Pause" : "Re-arm"}
                  >
                    {armed ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
                  </button>
                  <button type="button" className="tbtn !h-7 !px-1.5" onClick={() => removeAlert(a.id)} aria-label="Delete alert" title="Delete">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })
          )
        ) : log.length === 0 ? (
          <p className="p-4 text-[12px] text-[var(--mute)]">Nothing has fired yet.</p>
        ) : (
          log.map((e) => (
            <button
              key={e.id}
              type="button"
              className="row-hover block w-full border-b border-[var(--rule)] px-3 py-2 text-left"
              onClick={() => onSelect(e.symbol)}
            >
              <div className="text-[13px]">{e.message}</div>
              <div className="num text-[11px] text-[var(--mute)]">
                {new Date(e.at).toLocaleDateString("en-CA")} {fmtClock(e.at)} · last {fmtPrice(e.price)}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

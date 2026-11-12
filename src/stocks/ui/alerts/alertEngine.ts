import { useEffect, useRef } from "react";
import { playAlertBeep } from "../../../lib/chart-plugins/drawing-tools/line-alerts.ts";
import { toast } from "../../../services/toast.ts";
import { fmtPrice } from "../format.ts";
import { getSnapshot, subscribeSnapshots } from "../market.ts";
import { isArmed, useStocksUi, type PriceAlert } from "../store.ts";

/**
 * Price alerts on any symbol, checked on every snapshot poll (not only the
 * charted one). A crossing is the previous poll's last on one side of the
 * level and this poll's on the other.
 */

export function crossed(
  condition: PriceAlert["condition"],
  level: number,
  prev: number,
  next: number,
): boolean {
  const up = prev < level && next >= level;
  const down = prev > level && next <= level;
  if (condition === "above") return up;
  if (condition === "below") return down;
  return up || down;
}

export function describe(a: Pick<PriceAlert, "symbol" | "condition" | "price">): string {
  const verb = a.condition === "above" ? "crossed above" : a.condition === "below" ? "crossed below" : "crossed";
  return `${a.symbol} ${verb} ${fmtPrice(a.price)}`;
}

export function useAlertEngine(): void {
  const lastSeen = useRef(new Map<string, number>());
  useEffect(() => {
    return subscribeSnapshots(() => {
      const { alerts, updateAlert, logAlert } = useStocksUi.getState();
      const symbols = new Set(alerts.filter(isArmed).map((a) => a.symbol));
      for (const symbol of symbols) {
        const last = getSnapshot(symbol)?.last;
        if (last == null) continue;
        const prev = lastSeen.current.get(symbol);
        lastSeen.current.set(symbol, last);
        if (prev == null || prev === last) continue;
        for (const a of alerts) {
          if (a.symbol !== symbol || !isArmed(a)) continue;
          if (!crossed(a.condition, a.price, prev, last)) continue;
          const message = a.note ? `${describe(a)} · ${a.note}` : describe(a);
          updateAlert(a.id, { triggeredAt: Date.now() });
          logAlert({ alertId: a.id, symbol, message, price: last, at: Date.now() });
          toast.info("Alert", message);
          playAlertBeep();
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            try {
              new Notification("OpenCharts alert", { body: message, tag: a.id });
            } catch {
              /* notifications blocked */
            }
          }
        }
      }
    });
  }, []);
}

import { useEffect, useState } from "react";
import { OpenChartsProvider } from "../../adapter/provider.tsx";
import { TerminalProvider } from "../../terminal/context.tsx";
import { createAlpacaAdapter } from "../data/adapter.ts";
import { snapshotStore } from "../data/snapshots.ts";
import { setSnapshotSource } from "./market.ts";
import { StockWorkspace } from "./StockWorkspace.tsx";
import "./stocks.css";

/**
 * The US-stock app (VITE_ADAPTER=alpaca): Alpaca market data through the
 * dev-server proxy, the terminal's shared state, and the stock workspace
 * layout. Read-only: there is no trading gateway, so no order entry.
 */
// The adapter writes to the app-wide store; register it before any component
// subscribes (child effects run before a parent's, so an effect here is too late).
setSnapshotSource(snapshotStore);

export default function StocksApp() {
  const [adapter] = useState(() => createAlpacaAdapter({ store: snapshotStore }));

  useEffect(() => {
    document.title = "OpenCharts · US stocks";
  }, []);

  return (
    <OpenChartsProvider adapter={adapter}>
      <TerminalProvider>
        <StockWorkspace />
      </TerminalProvider>
    </OpenChartsProvider>
  );
}

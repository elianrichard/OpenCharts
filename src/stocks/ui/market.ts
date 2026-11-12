import { useSyncExternalStore } from "react";
import type { StockSnapshot } from "../types.ts";

/**
 * React access to the live snapshot store. The Alpaca adapter owns the one
 * poller; the workspace registers its store here at startup so components
 * never start a second poll.
 */

export interface SnapshotSource {
  subscribe(listener: () => void): () => void;
  get(symbol: string): StockSnapshot | undefined;
  /** Bumped on every change, so a list can re-render once per poll. */
  version(): number;
}

let source: SnapshotSource | null = null;
const noop = () => () => {};

export function setSnapshotSource(next: SnapshotSource | null): void {
  source = next;
}

export function useSnapshot(symbol: string | undefined): StockSnapshot | undefined {
  return useSyncExternalStore(
    source ? source.subscribe : noop,
    () => (symbol && source ? source.get(symbol) : undefined),
    () => undefined,
  );
}

/** Re-renders once per poll; read values with `getSnapshot` during render. */
export function useSnapshotVersion(): number {
  return useSyncExternalStore(
    source ? source.subscribe : noop,
    () => (source ? source.version() : 0),
    () => 0,
  );
}

export function getSnapshot(symbol: string): StockSnapshot | undefined {
  return source?.get(symbol);
}

export function subscribeSnapshots(listener: () => void): () => void {
  return source ? source.subscribe(listener) : () => {};
}

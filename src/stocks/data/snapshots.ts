import type { StockSnapshot } from "../types.ts";

/**
 * Latest StockSnapshot per symbol, filled by the Alpaca adapter's poller so
 * the UI can read change %, volume and extended-hours prices without a second
 * poll. Snapshots are replaced, never mutated: an unchanged symbol keeps its
 * object, so identity comparisons (useSyncExternalStore) work.
 */

export type SnapshotListener = (changed: string[]) => void;

export interface SnapshotStore {
  get(symbol: string): StockSnapshot | undefined;
  /** Immutable map; a new object after every change. */
  getAll(): Readonly<Record<string, StockSnapshot>>;
  /** Bumped on every change. */
  version(): number;
  /** Called with the symbols that changed. */
  subscribe(listener: SnapshotListener): () => void;
  /** Merge a poll result; returns the symbols whose snapshot changed. */
  update(snapshots: Record<string, StockSnapshot>): string[];
  clear(): void;
}

function sameExtended(a: StockSnapshot["extended"], b: StockSnapshot["extended"]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.price === b.price &&
    a.change === b.change &&
    a.changePct === b.changePct &&
    a.session === b.session &&
    a.time === b.time
  );
}

export function sameSnapshot(a: StockSnapshot, b: StockSnapshot): boolean {
  return (
    a.symbol === b.symbol &&
    a.last === b.last &&
    a.lastTime === b.lastTime &&
    a.prevClose === b.prevClose &&
    a.change === b.change &&
    a.changePct === b.changePct &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.volume === b.volume &&
    a.avgVolume30 === b.avgVolume30 &&
    a.bid === b.bid &&
    a.ask === b.ask &&
    sameExtended(a.extended, b.extended)
  );
}

export function createSnapshotStore(): SnapshotStore {
  let all: Readonly<Record<string, StockSnapshot>> = Object.freeze({});
  let version = 0;
  const listeners = new Set<SnapshotListener>();

  const notify = (changed: string[]) => {
    for (const listener of [...listeners]) {
      try {
        listener(changed);
      } catch (err) {
        console.error("[stocks] snapshot listener threw", err);
      }
    }
  };

  return {
    get: (symbol) => all[symbol],
    getAll: () => all,
    version: () => version,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(snapshots) {
      const changed: string[] = [];
      let next: Record<string, StockSnapshot> | null = null;
      for (const [symbol, snap] of Object.entries(snapshots)) {
        const prev = all[symbol];
        if (prev && sameSnapshot(prev, snap)) continue;
        next ??= { ...all };
        next[symbol] = snap;
        changed.push(symbol);
      }
      if (next) {
        all = Object.freeze(next);
        version += 1;
        notify(changed);
      }
      return changed;
    },
    clear() {
      if (Object.keys(all).length === 0) return;
      const symbols = Object.keys(all);
      all = Object.freeze({});
      version += 1;
      notify(symbols);
    },
  };
}

/** The app-wide store the default adapter fills. */
export const snapshotStore: SnapshotStore = createSnapshotStore();

export const getSnapshot = (symbol: string): StockSnapshot | undefined => snapshotStore.get(symbol);
export const getSnapshots = (): Readonly<Record<string, StockSnapshot>> => snapshotStore.getAll();
export const subscribeSnapshots = (listener: SnapshotListener): (() => void) => snapshotStore.subscribe(listener);

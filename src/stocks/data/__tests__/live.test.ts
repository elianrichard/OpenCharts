import { describe, expect, it, vi } from "vitest";
import type { Bar, StockSnapshot } from "../../types.ts";
import { buildLiveBar, chartTrade, latestTrade, tickTimestamp } from "../live.ts";
import { alpacaBarOpenMs } from "../time.ts";
import { createSnapshotStore } from "../snapshots.ts";

const at = (iso: string) => Date.parse(iso);
const sec = (iso: string) => at(iso) / 1000;

function snap(over: Partial<StockSnapshot> = {}): StockSnapshot {
  return {
    symbol: "AAPL",
    last: 357.1,
    lastTime: at("2026-11-12T15:00:00Z"),
    prevClose: 355.63,
    change: 1.47,
    changePct: 0.41,
    open: 356.5,
    high: 357.2,
    low: 355.9,
    volume: 5_000_000,
    avgVolume30: 40_000_000,
    bid: 357.05,
    ask: 357.12,
    extended: null,
    ...over,
  };
}

const bar = (iso: string, o: number, h: number, l: number, c: number, v: number): Bar => ({
  time: sec(iso),
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});

describe("trades", () => {
  it("prefers an extended-hours print for ticks and intraday bars", () => {
    const s = snap({ extended: { price: 358, change: 0.9, changePct: 0.25, session: "post", time: at("2026-11-12T22:00:00Z") } });
    expect(latestTrade(s)).toEqual({ price: 358, ms: at("2026-11-12T22:00:00Z") });
    expect(chartTrade("5m", s)?.price).toBe(358);
    // Daily and weekly bars are regular-session only.
    expect(chartTrade("1d", s)?.price).toBe(357.1);
    expect(latestTrade(undefined)).toBeNull();
  });
});

describe("buildLiveBar", () => {
  const now = at("2026-11-12T15:00:05Z");

  it("folds today's trade and session range into today's daily bar", () => {
    const base = bar("2026-11-12T05:00:00Z", 356.5, 357.0, 356.0, 356.8, 4_000_000);
    expect(buildLiveBar("1d", base, snap(), now)).toEqual(
      bar("2026-11-12T05:00:00Z", 356.5, 357.2, 355.9, 357.1, 5_000_000),
    );
  });

  it("opens today's daily bar from the snapshot before /bars has it", () => {
    const yesterday = bar("2026-11-11T05:00:00Z", 349, 355.6, 349, 355.36, 34_000_000);
    expect(buildLiveBar("1d", yesterday, snap(), now)).toEqual(
      bar("2026-11-12T05:00:00Z", 356.5, 357.2, 355.9, 357.1, 5_000_000),
    );
  });

  it("leaves an earlier session's bar alone (snapshots are unadjusted)", () => {
    const yesterday = bar("2026-11-11T05:00:00Z", 349, 355.6, 349, 355.36, 34_000_000);
    const preMarket = snap({ last: 355.63, lastTime: at("2026-11-11T20:59:59Z") });
    expect(buildLiveBar("1d", yesterday, preMarket, at("2026-11-12T12:00:00Z"))).toBe(yesterday);
  });

  it("closes the weekly bar on the regular price", () => {
    const week = bar("2026-11-09T05:00:00Z", 344.7, 357.0, 344.5, 356.8, 113_000_000);
    expect(buildLiveBar("1w", week, snap(), now)).toEqual(
      bar("2026-11-09T05:00:00Z", 344.7, 357.2, 344.5, 357.1, 113_000_000),
    );
  });

  it("starts a new intraday bar on the trade's bucket", () => {
    const base = bar("2026-11-12T14:55:00Z", 357, 357.1, 356.9, 357, 1_000);
    expect(buildLiveBar("5m", base, snap(), now)).toEqual(bar("2026-11-12T15:00:00Z", 357.1, 357.1, 357.1, 357.1, 0));
    const same = bar("2026-11-12T15:00:00Z", 357, 357.05, 356.9, 357, 1_000);
    expect(buildLiveBar("5m", same, snap(), now)).toEqual(bar("2026-11-12T15:00:00Z", 357, 357.1, 356.9, 357.1, 1_000));
  });

  it("keeps a base that is already newer than the trade", () => {
    const base = bar("2026-11-12T15:05:00Z", 357, 357.1, 356.9, 357, 1_000);
    expect(buildLiveBar("5m", base, snap(), now)).toBe(base);
    expect(buildLiveBar("5m", null, undefined, now)).toBeNull();
  });
});

describe("tickTimestamp", () => {
  const DAY = 86_400_000;
  const WEEK = 7 * DAY;
  /** ChartPanel's tick bucket (getCandleBucketTime), in ms. */
  const bucket = (ms: number, size: number) => Math.floor(ms / size) * size;
  const trade = (iso: string, price = 357) => ({ price, ms: at(iso) });

  it("keeps the real time for a regular trade early in the week", () => {
    const t = trade("2026-11-10T15:00:00Z"); // Tuesday 10:00 ET
    expect(tickTimestamp(t, snap({ lastTime: t.ms }))).toBe(t.ms);
  });

  it("holds Thursday and Friday trades inside the weekly bar's UTC bucket", () => {
    const t = trade("2026-11-12T15:00:00Z"); // Thursday
    expect(tickTimestamp(t, snap({ lastTime: t.ms }))).toBe(at("2026-11-11T23:59:59.999Z"));
  });

  it("dates extended-hours prints before the regular session's week", () => {
    const post = trade("2026-11-11T00:30:00Z"); // Tuesday 19:30 ET
    const close = at("2026-11-10T20:59:59Z");
    expect(tickTimestamp(post, snap({ lastTime: close }))).toBe(at("2026-11-09T04:59:59.999Z"));
    const pre = trade("2026-11-16T13:00:00Z"); // Monday 08:00 ET, after a Friday close
    expect(tickTimestamp(pre, snap({ lastTime: at("2026-11-13T20:59:59Z") }))).toBe(at("2026-11-09T04:59:59.999Z"));
  });

  it("never lands in a later UTC bucket than the daily or weekly bar, all week long", () => {
    for (let ms = at("2026-11-09T14:30:00Z"); ms < at("2026-11-14T00:00:00Z"); ms += 30 * 60_000) {
      const ts = tickTimestamp({ price: 1, ms }, snap({ lastTime: ms }));
      if (new Date(ms).getUTCHours() >= 14 && new Date(ms).getUTCHours() < 21) {
        expect(bucket(ts, DAY)).toBeLessThanOrEqual(alpacaBarOpenMs("1d", ms));
        expect(bucket(ts, WEEK)).toBeLessThanOrEqual(alpacaBarOpenMs("1w", ms));
      }
      expect(ts).toBeLessThanOrEqual(ms);
    }
  });
});

describe("snapshot store", () => {
  it("replaces changed snapshots only and notifies with their symbols", () => {
    const store = createSnapshotStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const a = snap();
    const b = snap({ symbol: "MSFT", last: 520 });
    expect(store.update({ AAPL: a, MSFT: b })).toEqual(["AAPL", "MSFT"]);
    const all = store.getAll();
    const v = store.version();

    // Same values: nothing changes, identities survive.
    expect(store.update({ AAPL: { ...a } })).toEqual([]);
    expect(store.get("AAPL")).toBe(a);
    expect(store.getAll()).toBe(all);
    expect(store.version()).toBe(v);

    expect(store.update({ AAPL: snap({ last: 358 }) })).toEqual(["AAPL"]);
    expect(store.get("MSFT")).toBe(b);
    expect(store.getAll()).not.toBe(all);
    expect(listener).toHaveBeenLastCalledWith(["AAPL"]);

    store.clear();
    expect(store.get("AAPL")).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

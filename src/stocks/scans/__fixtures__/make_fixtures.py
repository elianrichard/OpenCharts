#!/usr/bin/env python
"""Golden fixtures for src/stocks/scans (TypeScript port of trading-script's scans).

Run with the trading-script virtualenv:

    ../trading-script/.venv/bin/python src/stocks/scans/__fixtures__/make_fixtures.py \
        [--trading-script ../trading-script]

Inputs are the cached Alpaca SIP CSVs in trading-script/.data_cache. Nothing
touches the network or trading-script/.env: `backtest.data` is replaced by a
stub that serves the prepared frames (the real module calls load_dotenv() and
tops the cache up from Alpaca).

Each case runs the real Python (backtest.indicators, railway/div_scan.scan,
railway/stoch_scan.scan) twice:
  native  pandas as installed;
  x86     the same, with pandas' cython ewm kernel swapped for a pure-Python
          copy of its algorithm evaluated without fused multiply-add.
pandas wheels for arm64 let the compiler fuse `old_wt*w + new_wt*x` in the ewm
update into an FMA; x86-64 wheels (e.g. the Railway deploy) and JavaScript do
not. The script proves the swap is the only difference (native == the kernel
evaluated with math.fma on arm64, == without it on x86), asserts that every
integer / state output is identical in both modes, records the largest float
difference, and writes the x86 results — which the TypeScript must match bit
for bit.
"""
import argparse
import json
import math
import os
import platform
import sys
import types
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]

EPOCH = pd.Timestamp("1970-01-01")
DAILY_TRIM = 1200   # daily bars kept per case (Python runs on the same trimmed input)
IND_TAIL = 60       # indicator values stored at the end of every daily case
IND_HEAD = 250      # ... and at the start (warmup / seeding) where the case asks for it
NOW_DROP = "2026-11-03T00:00:00"   # the 2026-11-02 week is still forming -> dropped
NOW_KEEP = "2026-11-07T00:00:00"   # past Friday 21:00 UTC -> that week counts as closed

# name, symbol, daily spec, weekly spec. `end` truncates the cached history
# (exclusive bar index) to put a fresh signal on the last bar.
CASES = [
    dict(name="AVGO", symbol="AVGO", daily=dict(), weekly=dict(now=NOW_DROP)),   # div HOLD, stoch CONFIRMED fresh
    dict(name="AVAV", symbol="AVAV", daily=dict(), weekly=dict(now=NOW_KEEP)),   # div EXIT, forming week kept
    dict(name="JBL", symbol="JBL", daily=dict(), weekly=dict(now=NOW_DROP)),     # div HOLD, stoch FAILED
    dict(name="XYZ", symbol="XYZ", daily=dict(head=True), weekly=dict(now=NOW_DROP)),  # flat, no events
    dict(name="MSFT_NEW", symbol="MSFT", daily=dict(end=2633)),                  # signal on the last bar -> NEW
    dict(name="EW", symbol="EW", weekly=dict(now=NOW_DROP)),                     # CONFIRMED on the last closed bar
    dict(name="EW_ARMED", symbol="EW", weekly=dict(end=303, now=NOW_DROP)),      # ARMED, awaiting confirm
]


# ── trading-script imports (stubbed data layer) ───────────

def import_trading_script(ts_root):
    for k in ("ACCOUNT_SIZE", "DIV_POSITION_PCT", "RISK_PCT", "MAX_POSITION_PCT"):
        os.environ.pop(k, None)
    frames = {}

    def load(symbol, start=None, end=None, interval="1d", source="alpaca", max_bars=0):
        return frames[(symbol, interval)].copy()

    stub = types.ModuleType("backtest.data")
    stub.load = load
    sys.modules["backtest.data"] = stub
    sys.path.insert(0, str(ts_root))
    sys.path.insert(0, str(ts_root / "railway"))
    import backtest.indicators as ind
    import div_scan
    import stoch_scan
    return ind, div_scan, stoch_scan, frames


# ── ewm kernels ───────────────────────────────────────────

def ewm_kernel(values, com, fma):
    """pandas cython `ewm` (adjust=False, ignore_na=False, normalize=True, minp=1)."""
    x = np.asarray(values, dtype=float)
    alpha = 1.0 / (1.0 + com)
    owf = 1.0 - alpha
    new_wt = alpha
    out = np.empty(len(x))
    if not len(x):
        return out
    w = x[0]
    old_wt = 1.0
    out[0] = w
    for i in range(1, len(x)):
        cur = x[i]
        if w == w:
            old_wt *= owf
            if com == 1:   # pandas' "irregular-interval" branch
                new_wt = 1.0 - old_wt
            if cur == cur:
                if w != cur:
                    w = (math.fma(old_wt, w, new_wt * cur) if fma
                         else old_wt * w + new_wt * cur) / (old_wt + new_wt)
                old_wt = 1.0
        elif cur == cur:
            w = cur
        out[i] = w
    return out


def ewm_series(s, com, fma=False):
    return pd.Series(ewm_kernel(s.to_numpy(dtype=float), com, fma), index=s.index)


def com_alpha(alpha):
    return (1 - alpha) / alpha


def com_span(span):
    return (span - 1) / 2


class Mode:
    """Swap backtest.indicators' ewm users for the non-FMA kernel."""

    def __init__(self, ind):
        self.ind = ind
        self.native = {k: getattr(ind, k) for k in ("rma", "macd_line", "macd_all", "ema")}

    def set(self, mode):
        ind = self.ind
        for k, f in self.native.items():
            setattr(ind, k, f)
        if mode == "x86":
            ind.rma = lambda s, n: ewm_series(s, com_alpha(1.0 / n))
            ind.ema = lambda s, n: ewm_series(s, com_span(n))

            def macd_line(c, fast=12, slow=26):
                return ewm_series(c, com_span(fast)) - ewm_series(c, com_span(slow))

            def macd_all(c, fast=12, slow=26, sig=9):
                m = macd_line(c, fast, slow)
                s = ewm_series(m, com_span(sig))
                return m, s, m - s

            ind.macd_line, ind.macd_all = macd_line, macd_all


def check_kernel_model(close):
    """native pandas ewm must equal our kernel with or without FMA, bit for bit."""
    native = close.ewm(span=12, adjust=False).mean().to_numpy()
    for fma in (True, False):
        mine = ewm_kernel(close.to_numpy(dtype=float), com_span(12), fma)
        if np.array_equal(native, mine, equal_nan=True):
            return "fma" if fma else "plain"
    raise SystemExit("pandas ewm matches neither kernel model — re-derive make_fixtures.py")


# ── encoding ──────────────────────────────────────────────

def ts_sec(ts):
    return int((pd.Timestamp(ts) - EPOCH) // pd.Timedelta(seconds=1))


def fl(x):
    if x is None:
        return None
    x = float(x)
    if math.isnan(x):
        return None
    if math.isinf(x):
        return "inf" if x > 0 else "-inf"
    return x


def arr(a):
    return [fl(v) for v in np.asarray(a, dtype=float)]


def num(v):
    v = float(v)
    return int(v) if v.is_integer() else v


def bars_json(df):
    return dict(
        t=[ts_sec(t) for t in df.index],
        o=[num(v) for v in df["open"]],
        h=[num(v) for v in df["high"]],
        l=[num(v) for v in df["low"]],
        c=[num(v) for v in df["close"]],
        v=[num(v) for v in df["volume"]],
    )


def opt_ts(v):
    return None if v is None else ts_sec(v)


def opt_int(v):
    return None if v is None else int(v)


def div_row(r):
    return dict(symbol=r["symbol"], lastBar=ts_sec(r["last_bar"]), price=fl(r["price"]),
                divNow=int(r["div_now"]), divSum=int(r["div_sum"]), ibs=fl(r["ibs"]),
                state=r["state"], signalDate=opt_ts(r["signal_date"]),
                entryDate=opt_ts(r["entry_date"]), entry=fl(r["entry"]),
                held=opt_int(r["held"]), left=opt_int(r["left"]), pnlPct=fl(r["pnl_pct"]))


def stoch_row(r):
    crosses = None if r["c1"] is None else [fl(r[f"c{j}"]) for j in range(1, 5)]
    gaps = None if r["g1"] is None else [int(r[f"g{j}"]) for j in range(1, 4)]
    return dict(symbol=r["symbol"], interval=r["interval"], lastBar=ts_sec(r["last_bar"]),
                price=fl(r["price"]), stage=r["stage"], signalDate=opt_ts(r["signal_date"]),
                daysSince=opt_int(r["days_since"]), entry=fl(r["entry"]), sl=fl(r["sl"]),
                tp=fl(r["tp"]), fresh=bool(r["fresh"]), crosses=crosses, gaps=gaps,
                nEvents=int(r["n_events"]))


# ── per-case computations ─────────────────────────────────

def all_trades(hit, hold):
    """div_scan.last_trade, keeping every trade of the replay."""
    i, out, n = 0, [], len(hit)
    while i < n:
        if hit[i]:
            out.append((i, i + 1, i + 1 + hold))
            i += 1 + hold
        else:
            i += 1
    return out


def tv_check(df, chain, cap=10000.0, pct=10.0, comm_pct=0.1):
    """Independent re-statement of divergence-buy.pine's sizing (cross-check only)."""
    c = comm_pct / 100
    o, cl = df["open"].to_numpy(), df["close"].to_numpy()
    last = len(df) - 1
    eq, out = cap, []
    for sig, e, x in chain:
        if e > last:
            break
        qty = math.floor(eq * pct / 100 / cl[sig])
        entry = o[e]
        if x <= last:
            pnl = qty * (o[x] - entry) - c * qty * entry - c * qty * o[x]
            eq += pnl
            out.append(dict(qty=qty, pnl=fl(pnl), equity=fl(eq)))
        else:
            pnl = qty * (cl[last] - entry) - c * qty * entry
            out.append(dict(qty=qty, pnl=fl(pnl), equity=None))
    return out


def daily_outputs(ind, div_scan, frames, symbol, df, segments):
    frames[(symbol, "1d")] = df
    dv = ind.regular_divergence(df)
    row = div_scan.scan(symbol)
    div = dv["div_pos"]
    div_sum = div.rolling(div_scan.DIV_WINDOW).sum()
    ibs = ((df["close"] - df["low"]) / (df["high"] - df["low"])).fillna(0.5)
    hit = ((div_sum >= div_scan.DIV_MIN) & (ibs <= div_scan.IBS_MAX)).to_numpy()
    chain = all_trades(hit, div_scan.HOLD_BARS)
    assert (chain[-1] if chain else None) == div_scan.last_trade(hit)

    c = df["close"]
    m, s, h = ind.macd_all(c)
    k, d = ind.stoch_rsi(c, 14, 14, 5, 5)
    series = dict(macd=m, signal=s, hist=h, rsi=ind.rsi(c), stoch=ind.stoch_k(df),
                  cci=ind.cci(df), mom=ind.momentum(c), obv=ind.obv(df),
                  vwmacd=ind.vwmacd(df), cmf=ind.cmf(df), mfi=ind.mfi(df),
                  atr=ind.atr(df, 14), stochRsiK=k, stochRsiD=d)
    return dict(
        ints=dict(divPos=[int(v) for v in div], divNeg=[int(v) for v in dv["div_neg"]],
                  trades=[[a, b, x, int(div_sum.iloc[a])] for a, b, x in chain]),
        row=div_row(row),
        floats={f"{name}@{a}": np.asarray(v, dtype=float)[a:b]
                for a, b in segments for name, v in series.items()},
        tv=tv_check(df, chain),
    )


def weekly_outputs(ind, stoch_scan, frames, symbol, dfw, now):
    frames[(symbol, "1w")] = dfw
    orig = stoch_scan._fixture_orig_drop
    dropped = orig(dfw, "1w", now)
    k, d = ind.stoch_rsi(dropped["close"], stoch_scan.RSI_LEN, stoch_scan.STOCH_LEN,
                         stoch_scan.SMOOTH_K, stoch_scan.SMOOTH_D)
    events = stoch_scan.detect(k.to_numpy(), d.to_numpy())
    stoch_scan.drop_forming = lambda df, iv, now_=None: orig(df, iv, now)
    try:
        row = stoch_scan.scan(symbol, "1w")
    finally:
        stoch_scan.drop_forming = orig
    return dict(
        ints=dict(dropped=len(dfw) - len(dropped),
                  events=[dict(stage=e["stage"], i=int(e["i"]), crossBar=int(e["cross_bar"]),
                               gaps=[int(g) for g in e["gaps"]]) for e in events]),
        eventC=[[float(v) for v in e["c"]] for e in events],
        row=stoch_row(row),
        floats=dict(k=k.to_numpy(), d=d.to_numpy(),
                    atr=ind.atr(dropped, stoch_scan.ATR_LEN).to_numpy()),
    )


def rel_diff(a, b):
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    if not np.array_equal(np.isnan(a), np.isnan(b)):
        return math.inf
    m = ~np.isnan(a)
    if not m.any():
        return 0.0
    den = np.maximum(np.abs(a[m]), 1e-12)
    return float(np.max(np.abs(a[m] - b[m]) / den))


def row_diff(ra, rb):
    """Max relative diff over float fields; raises if any non-float field differs."""
    worst = 0.0
    for key in ra:
        va, vb = ra[key], rb[key]
        if isinstance(va, float) or isinstance(vb, float):
            worst = max(worst, rel_diff([va if va is not None else np.nan],
                                        [vb if vb is not None else np.nan]))
        elif isinstance(va, list) and va and isinstance(va[0], float):
            worst = max(worst, rel_diff(va, vb))
        elif va != vb:
            raise SystemExit(f"native vs x86 differ on {key}: {va!r} != {vb!r}")
    return worst


def read_csv(path):
    df = pd.read_csv(path, index_col=0)
    df.index = pd.to_datetime(df.index, utc=True).tz_localize(None)
    return df


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--trading-script", default=os.getenv("TRADING_SCRIPT") or str(REPO.parent / "trading-script"))
    ap.add_argument("--out", default=str(HERE))
    args = ap.parse_args()
    ts_root = Path(args.trading_script).resolve()
    cache = ts_root / ".data_cache"

    ind, div_scan, stoch_scan, frames = import_trading_script(ts_root)
    stoch_scan._fixture_orig_drop = stoch_scan.drop_forming
    mode = Mode(ind)

    for case in CASES:
        sym = case["symbol"]
        out = dict(case=case["name"], symbol=sym,
                   meta=dict(generator="src/stocks/scans/__fixtures__/make_fixtures.py",
                             pandas=pd.__version__, numpy=np.__version__,
                             machine=platform.machine(), expected="x86 (no-FMA ewm)"))
        results = {}
        daily_df = weekly_df = None
        if "daily" in case:
            spec = case["daily"]
            full = read_csv(cache / f"alpaca-sip_{sym}_2016-01-01_None_1d.csv")
            daily_df = full.iloc[:spec.get("end", len(full))].tail(spec.get("trim", DAILY_TRIM))
            out["meta"]["nativeEwm"] = check_kernel_model(daily_df["close"])
        if "weekly" in case:
            spec = case["weekly"]
            full = read_csv(cache / f"alpaca-sip_{sym}_2021-01-01_None_1w.csv")
            weekly_df = full.iloc[:spec.get("end", len(full))]
            now = pd.Timestamp(spec["now"])

        for m in ("native", "x86"):
            mode.set(m)
            res = {}
            if daily_df is not None:
                n = len(daily_df)
                segments = ([(0, IND_HEAD)] if case["daily"].get("head") else []) + [(n - IND_TAIL, n)]
                res["daily"] = daily_outputs(ind, div_scan, frames, sym, daily_df, segments)
                res["daily"]["segments"] = segments
            if weekly_df is not None:
                res["weekly"] = weekly_outputs(ind, stoch_scan, frames, sym, weekly_df, now)
            results[m] = res
        mode.set("native")

        nat, x86 = results["native"], results["x86"]
        worst = 0.0
        for part in ("daily", "weekly"):
            if part not in x86:
                continue
            if nat[part]["ints"] != x86[part]["ints"]:
                raise SystemExit(f"{case['name']} {part}: integer outputs differ native vs x86")
            worst = max(worst, row_diff(nat[part]["row"], x86[part]["row"]))
            for name in x86[part]["floats"]:
                worst = max(worst, rel_diff(nat[part]["floats"][name], x86[part]["floats"][name]))
        out["meta"]["nativeMaxRelDiff"] = worst

        if "daily" in x86:
            r = x86["daily"]
            out["daily"] = dict(bars=bars_json(daily_df), divPos=r["ints"]["divPos"],
                                divNeg=r["ints"]["divNeg"], scan=r["row"],
                                trades=r["ints"]["trades"], tv=r["tv"],
                                indicators=[dict(start=a, values={k.split("@")[0]: arr(v)
                                                                  for k, v in r["floats"].items()
                                                                  if k.endswith(f"@{a}")})
                                            for a, _ in r["segments"]])
        if "weekly" in x86:
            r = x86["weekly"]
            out["weekly"] = dict(bars=bars_json(weekly_df), nowMs=ts_sec(now) * 1000,
                                 dropped=r["ints"]["dropped"],
                                 k=arr(r["floats"]["k"]), d=arr(r["floats"]["d"]),
                                 atr=arr(r["floats"]["atr"]),
                                 events=[dict(e, c=c) for e, c in zip(r["ints"]["events"], r["eventC"])],
                                 scan=r["row"])

        path = Path(args.out) / f"{case['name']}.json"
        path.write_text(json.dumps(out, separators=(",", ":"), allow_nan=False))
        d = out.get("daily", {}).get("scan", {})
        w = out.get("weekly", {}).get("scan", {})
        print(f"{case['name']:9s} daily={d.get('state', '-')!s:5s} trades={len(out.get('daily', {}).get('trades', []))!s:3s} "
              f"weekly={w.get('stage', '-')!s:9s} events={w.get('nEvents', '-')!s:3s} "
              f"nativeMaxRelDiff={worst:.1e} {path.stat().st_size // 1024}KB")


if __name__ == "__main__":
    main()

/**
 * Ports of trading-script/backtest/indicators.py (the oscillators the
 * divergence engine and the Stoch RSI scan use).
 *
 * Pure functions: arrays in, `number[]` out, aligned to the input length, with
 * NaN where pandas would produce NaN (warmup, divide-by-zero guards).
 *
 * Bit-for-bit parity with pandas matters here: the divergence engine and the
 * Stoch RSI state machine compare values, so a 1-ulp drift can flip a count.
 * The kernels below therefore copy pandas' own algorithms rather than the
 * textbook formulas:
 *   - `ewmMean`      pandas `ewm(adjust=False).mean()` (cython `ewm`): seeds on
 *                    the first non-NaN value, alpha derived via the centre of
 *                    mass, normalised update `(w_old*x_old + a*x) / (w_old + a)`.
 *   - `rollingSum` / `rollingMean`  pandas' Kahan-compensated add/remove window
 *                    with its "run of identical values" exact-result rule.
 *   - `npMean`       numpy's pairwise summation (used by `rolling.apply`).
 *
 * One platform caveat: pandas wheels for arm64 (macOS / Linux aarch64) let the
 * C compiler fuse the ewm update into an FMA, x86-64 wheels do not. JavaScript
 * never fuses, so these ports equal pandas on x86-64 (e.g. the Railway deploy)
 * exactly and pandas on arm64 to ~1e-13.
 */

// ── pandas / numpy kernels ────────────────────────────────

/** `Series.ewm(com=com, adjust=False).mean()` — ignore_na=False, min_periods=1. */
export function ewmMean(x: readonly number[], com: number): number[] {
  const n = x.length;
  const out = new Array<number>(n);
  if (n === 0) return out;
  const alpha = 1 / (1 + com);
  const oldWtFactor = 1 - alpha;
  let newWt = alpha; // adjust=False
  let weighted = x[0]!;
  let oldWt = 1;
  out[0] = weighted; // NaN until the first observation
  for (let i = 1; i < n; i++) {
    const cur = x[i]!;
    const isObs = cur === cur;
    if (weighted === weighted) {
      // ignore_na=False: a NaN after seeding still decays the old weight
      oldWt *= oldWtFactor;
      // pandas' "irregular-interval" branch, taken whenever com == 1
      if (com === 1) newWt = 1 - oldWt;
      if (isObs) {
        // "avoid numerical errors on constant series"
        if (weighted !== cur) weighted = (oldWt * weighted + newWt * cur) / (oldWt + newWt);
        oldWt = 1;
      }
    } else if (isObs) {
      weighted = cur;
    }
    out[i] = weighted;
  }
  return out;
}

/** pandas `span=` → centre of mass. */
export function comFromSpan(span: number): number {
  return (span - 1) / 2;
}

/** pandas `alpha=` → centre of mass. */
export function comFromAlpha(alpha: number): number {
  return (1 - alpha) / alpha;
}

/** Fixed-window bounds pandas uses for `rolling(w)` (closed="right"). */
function windowStart(i: number, w: number): number {
  return Math.max(0, i + 1 - w);
}

function signbit(v: number): boolean {
  return v < 0 || Object.is(v, -0);
}

/** `Series.rolling(w).sum()` (min_periods = w), pandas' Kahan algorithm. */
export function rollingSum(values: readonly number[], w: number): number[] {
  return rollingKahan(values, w, false);
}

/** `Series.rolling(w).mean()` (min_periods = w), pandas' Kahan algorithm. */
export function rollingMean(values: readonly number[], w: number): number[] {
  return rollingKahan(values, w, true);
}

function rollingKahan(values: readonly number[], w: number, mean: boolean): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  let nobs = 0;
  let negCt = 0;
  let sumX = 0;
  let compAdd = 0;
  let compRemove = 0;
  let prevValue = 0;
  let sameRun = 0;

  const add = (val: number) => {
    if (val !== val) return;
    nobs += 1;
    const y = val - compAdd;
    const t = sumX + y;
    compAdd = t - sumX - y;
    sumX = t;
    if (signbit(val)) negCt += 1;
    // GH#42064: count identical values to return them exactly
    if (val === prevValue) sameRun += 1;
    else sameRun = 1;
    prevValue = val;
  };
  const remove = (val: number) => {
    if (val !== val) return;
    nobs -= 1;
    const y = -val - compRemove;
    const t = sumX + y;
    compRemove = t - sumX - y;
    sumX = t;
    if (signbit(val)) negCt -= 1;
  };

  for (let i = 0; i < n; i++) {
    const s = windowStart(i, w);
    const e = i + 1;
    const prevEnd = i; // end[i - 1]
    if (i === 0 || s >= prevEnd) {
      compAdd = compRemove = sumX = 0;
      nobs = negCt = 0;
      prevValue = values[s]!;
      sameRun = 0;
      for (let j = s; j < e; j++) add(values[j]!);
    } else {
      for (let j = windowStart(i - 1, w); j < s; j++) remove(values[j]!);
      for (let j = prevEnd; j < e; j++) add(values[j]!);
    }

    let result: number;
    if (mean) {
      if (nobs >= w && nobs > 0) {
        result = sumX / nobs;
        if (sameRun >= nobs) result = prevValue;
        else if (negCt === 0 && result < 0) result = 0;
        else if (negCt === nobs && result > 0) result = 0;
      } else {
        result = NaN;
      }
    } else if (nobs === 0 && w === 0) {
      result = 0;
    } else if (nobs >= w) {
      result = sameRun >= nobs ? prevValue * nobs : sumX;
    } else {
      result = NaN;
    }
    out[i] = result;
  }
  return out;
}

/** `Series.rolling(w).min()` (min_periods = w). */
export function rollingMin(values: readonly number[], w: number): number[] {
  return rollingExtreme(values, w, -1);
}

/** `Series.rolling(w).max()` (min_periods = w). */
export function rollingMax(values: readonly number[], w: number): number[] {
  return rollingExtreme(values, w, 1);
}

function rollingExtreme(values: readonly number[], w: number, sign: 1 | -1): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const s = windowStart(i, w);
    let nobs = 0;
    let best = NaN;
    for (let j = s; j <= i; j++) {
      const v = values[j]!;
      if (v !== v) continue;
      nobs += 1;
      if (best !== best || (sign > 0 ? v > best : v < best)) best = v;
    }
    out[i] = nobs >= w ? best : NaN;
  }
  return out;
}

/** numpy's pairwise summation (`np.add.reduce` on a contiguous float64 array). */
export function npSum(a: readonly number[], from = 0, to = a.length): number {
  const n = to - from;
  if (n < 8) {
    let res = 0;
    for (let i = from; i < to; i++) res += a[i]!;
    return res;
  }
  if (n <= 128) {
    const r = [a[from]!, a[from + 1]!, a[from + 2]!, a[from + 3]!, a[from + 4]!, a[from + 5]!, a[from + 6]!, a[from + 7]!];
    let i = 8;
    for (; i < n - (n % 8); i += 8) {
      for (let j = 0; j < 8; j++) r[j]! += a[from + i + j]!;
    }
    // ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7)), exactly as numpy
    const lo = (r[0]! + r[1]!) + (r[2]! + r[3]!);
    const hi = (r[4]! + r[5]!) + (r[6]! + r[7]!);
    let res = lo + hi;
    for (; i < n; i++) res += a[from + i]!;
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return npSum(a, from, from + n2) + npSum(a, from + n2, to);
}

/** `np.mean` of a slice. */
export function npMean(a: readonly number[], from = 0, to = a.length): number {
  return npSum(a, from, to) / (to - from);
}

/** `Series.rolling(w).apply(fn, raw=True)`: fn only sees all-finite windows. */
function rollingApply(values: readonly number[], w: number, fn: (from: number, to: number) => number): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const s = windowStart(i, w);
    let finite = 0;
    for (let j = s; j <= i; j++) if (Number.isFinite(values[j])) finite += 1;
    out[i] = finite >= w ? fn(s, i + 1) : NaN;
  }
  return out;
}

/** `Series.diff()` */
export function diff(x: readonly number[]): number[] {
  return x.map((v, i) => (i === 0 ? NaN : v - x[i - 1]!));
}

/** `Series.shift(k)` for k >= 0. */
export function shift(x: readonly number[], k: number): number[] {
  return x.map((_, i) => (i < k ? NaN : x[i - k]!));
}

/** `.replace(0, np.nan)` */
function zeroToNaN(v: number): number {
  return v === 0 ? NaN : v;
}

// ── indicators (backtest/indicators.py) ───────────────────

/** Wilder smoothing: `ewm(alpha=1/n, adjust=False).mean()`. */
export function rma(x: readonly number[], n: number): number[] {
  return ewmMean(x, comFromAlpha(1.0 / n));
}

/** Pine `ta.ema`: `ewm(span=n, adjust=False).mean()`. */
export function ema(x: readonly number[], n: number): number[] {
  return ewmMean(x, comFromSpan(n));
}

/** True range (first bar = high - low) smoothed with RMA. */
export function atr(high: readonly number[], low: readonly number[], close: readonly number[], n: number): number[] {
  const tr = high.map((h, i) => {
    const l = low[i]!;
    if (i === 0) return h - l;
    const pc = close[i - 1]!;
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
  return rma(tr, n);
}

/** RSI with RMA averages; NaN (first bar, zero down-average) becomes 50. */
export function rsi(close: readonly number[], n = 14): number[] {
  const d = diff(close);
  const up = rma(
    d.map((v) => (v !== v ? NaN : v >= 0 ? v : 0)),
    n,
  );
  const dn = rma(
    d.map((v) => (v !== v ? NaN : -v >= 0 ? -v : 0)),
    n,
  );
  return up.map((u, i) => {
    const rs = u / zeroToNaN(dn[i]!);
    const r = 100 - 100 / (1 + rs);
    return r !== r ? 50 : r;
  });
}

/** Stoch RSI (pine/indicators/stoch-rsi.pine), each line 0..100. */
export function stochRsi(
  close: readonly number[],
  rsiLen = 14,
  stochLen = 14,
  smoothK = 3,
  smoothD = 3,
): { k: number[]; d: number[] } {
  const r = rsi(close, rsiLen);
  const ll = rollingMin(r, stochLen);
  const hh = rollingMax(r, stochLen);
  const st = r.map((v, i) => (100 * (v - ll[i]!)) / zeroToNaN(hh[i]! - ll[i]!));
  const k = rollingMean(st, smoothK);
  const d = rollingMean(k, smoothD);
  return { k, d };
}

/** MACD line, signal and histogram (the divergence script's `deltamacd`). */
export function macdAll(
  close: readonly number[],
  fast = 12,
  slow = 26,
  sig = 9,
): { macd: number[]; signal: number[]; hist: number[] } {
  const f = ema(close, fast);
  const s = ema(close, slow);
  const macd = f.map((v, i) => v - s[i]!);
  const signal = ema(macd, sig);
  const hist = macd.map((v, i) => v - signal[i]!);
  return { macd, signal, hist };
}

/** `close - close.shift(n)` */
export function momentum(close: readonly number[], n = 10): number[] {
  return close.map((v, i) => (i < n ? NaN : v - close[i - n]!));
}

/** Pine `cci(close, n)` — the divergence scripts pass close, not hlc3. */
export function cci(close: readonly number[], n = 10): number[] {
  const sma = rollingMean(close, n);
  const mad = rollingApply(close, n, (from, to) => {
    const m = npMean(close, from, to);
    const dev = new Array<number>(to - from);
    for (let j = from; j < to; j++) dev[j - from] = Math.abs(close[j]! - m);
    return npMean(dev);
  });
  return close.map((c, i) => (c - sma[i]!) / (0.015 * mad[i]!));
}

/** Slow stochastic %K: `sma(100 * (c - ll) / (hh - ll), smooth)`. */
export function stochK(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  n = 14,
  smooth = 3,
): number[] {
  const ll = rollingMin(low, n);
  const hh = rollingMax(high, n);
  const k = close.map((c, i) => (100 * (c - ll[i]!)) / (hh[i]! - ll[i]!));
  return rollingMean(k, smooth);
}

/** On-balance volume, starting at 0. */
export function obv(close: readonly number[], volume: readonly number[]): number[] {
  const out = new Array<number>(close.length);
  let acc = 0;
  for (let i = 0; i < close.length; i++) {
    const sign = i === 0 ? 0 : Math.sign(close[i]! - close[i - 1]!);
    acc += (sign !== sign ? 0 : sign) * volume[i]!;
    out[i] = acc;
  }
  return out;
}

/** Volume-weighted moving average. */
export function vwma(close: readonly number[], volume: readonly number[], n: number): number[] {
  const cv = rollingSum(
    close.map((c, i) => c * volume[i]!),
    n,
  );
  const v = rollingSum(volume, n);
  return cv.map((x, i) => x / v[i]!);
}

/** `vwma(fast) - vwma(slow)` */
export function vwmacd(close: readonly number[], volume: readonly number[], fast = 12, slow = 26): number[] {
  const f = vwma(close, volume, fast);
  const s = vwma(close, volume, slow);
  return f.map((v, i) => v - s[i]!);
}

/** Chaikin money flow; a zero-range bar is NaN (and so is every window holding it). */
export function cmf(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  volume: readonly number[],
  n = 21,
): number[] {
  const mfv = close.map((c, i) => {
    const h = high[i]!;
    const l = low[i]!;
    const mfm = (c - l - (h - c)) / zeroToNaN(h - l);
    return mfm * volume[i]!;
  });
  const num = rollingSum(mfv, n);
  const den = rollingSum(volume, n);
  return num.map((x, i) => x / den[i]!);
}

/** Pine `mfi(close, n)` — close, not hlc3; NaN while the negative flow is 0. */
export function mfi(close: readonly number[], volume: readonly number[], n = 14): number[] {
  const pos = close.map((c, i) => (i > 0 && c > close[i - 1]! ? c * volume[i]! : 0));
  const neg = close.map((c, i) => (i > 0 && c < close[i - 1]! ? c * volume[i]! : 0));
  const p = rollingSum(pos, n);
  const q = rollingSum(neg, n);
  return p.map((x, i) => {
    const mr = x / zeroToNaN(q[i]!);
    return 100 - 100 / (1 + mr);
  });
}

// ── bars helpers ──────────────────────────────────────────

export interface BarColumns {
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

/** Split bars into column arrays. */
export function barColumns(bars: readonly { time: number; open: number; high: number; low: number; close: number; volume: number }[]): BarColumns {
  const n = bars.length;
  const cols: BarColumns = {
    time: new Array<number>(n),
    open: new Array<number>(n),
    high: new Array<number>(n),
    low: new Array<number>(n),
    close: new Array<number>(n),
    volume: new Array<number>(n),
  };
  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    cols.time[i] = b.time;
    cols.open[i] = b.open;
    cols.high[i] = b.high;
    cols.low[i] = b.low;
    cols.close[i] = b.close;
    cols.volume[i] = b.volume;
  }
  return cols;
}

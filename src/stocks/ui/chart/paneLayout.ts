/**
 * Stacked indicator panes on a single lightweight-charts v4 pane.
 *
 * v4 has one pane, so "panes" are price scales given disjoint vertical bands
 * through `scaleMargins` (fractions of the price area, measured from the top
 * and from the bottom). The main price scale keeps the top, volume sits as an
 * overlay at the bottom of the main band (TradingView's default), and each
 * oscillator gets an equal band underneath.
 */

export interface PaneBand {
  /** Price-scale id the pane's series use. */
  scaleId: string;
  /** Band start / end as a fraction of the price area, from the top. */
  start: number;
  end: number;
  margins: { top: number; bottom: number };
}

export interface PaneLayout {
  main: { top: number; bottom: number };
  volume: { top: number; bottom: number };
  panes: PaneBand[];
  /** Fraction of the price area the oscillator panes take together. */
  total: number;
}

const MAX_TOTAL = 0.56;
/** Air inside each band so lines never touch the separator. */
const PAD = 0.014;

export function paneHeight(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 0.24;
  if (count === 2) return 0.2;
  return MAX_TOTAL / count;
}

export function layoutPanes(
  scaleIds: readonly string[],
  volumeVisible: boolean,
  /** Fraction of the price area kept clear at the top (the legend). */
  top = 0.06,
): PaneLayout {
  const h = paneHeight(scaleIds.length);
  const total = h * scaleIds.length;
  const panes = scaleIds.map((scaleId, i) => {
    const start = 1 - total + i * h;
    const end = start + h;
    return {
      scaleId,
      start,
      end,
      margins: { top: start + PAD * 2.4, bottom: 1 - end + PAD },
    };
  });
  return {
    main: { top, bottom: total + (volumeVisible ? 0.14 : 0.04) },
    volume: { top: 1 - total - 0.13, bottom: total },
    panes,
    total,
  };
}

import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  SeriesPrimitivePaneViewZOrder,
  Time,
} from "lightweight-charts";
import { PluginBase } from "../../../lib/chart-plugins/plugin-base";
import type { Divergence } from "../../types.ts";

/**
 * Regular-divergence lines on the price series: a straight line between the
 * two price pivots, and a small label at the later pivot listing the
 * oscillators that agree (below the low for bullish, above the high for
 * bearish). Labels that would overlap an earlier one are skipped; the line
 * still draws.
 */

export interface DivergenceLineColors {
  bull: string;
  bear: string;
  labelInk: string;
  labelBg: string;
}

/** Short names, as the user's TradingView "MRS + DIV" label prints them. */
const SHORT: Record<string, string> = {
  macd: "MACD",
  hist: "Hist",
  rsi: "RSI",
  stoch: "Stoch",
  cci: "CCI",
  mom: "MOM",
  obv: "OBV",
  vwmacd: "VWMACD",
  cmf: "CMF",
  mfi: "MFI",
};

export function shortIndicatorName(name: string): string {
  return SHORT[name] ?? name.toUpperCase();
}

interface ScreenLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: Divergence["kind"];
  lines: string[];
}

class Renderer implements ISeriesPrimitivePaneRenderer {
  constructor(
    private readonly items: ScreenLine[],
    private readonly colors: DivergenceLineColors,
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      ctx.save();
      ctx.lineWidth = Math.max(1, Math.round(hr));
      for (const it of this.items) {
        ctx.strokeStyle = it.kind === "bull" ? this.colors.bull : this.colors.bear;
        ctx.beginPath();
        ctx.moveTo(it.x1 * hr, it.y1 * vr);
        ctx.lineTo(it.x2 * hr, it.y2 * vr);
        ctx.stroke();
      }

      const fontPx = 10;
      const lineH = 12;
      const padX = 4;
      ctx.font = `${Math.round(fontPx * vr)}px "JetBrains Mono Variable", "JetBrains Mono", monospace`;
      ctx.textBaseline = "top";
      const taken: { x: number; y: number; w: number; h: number }[] = [];
      for (const it of this.items) {
        if (it.lines.length === 0) continue;
        const w = Math.max(...it.lines.map((l) => ctx.measureText(l).width / hr)) + padX * 2;
        const h = it.lines.length * lineH + 4;
        const x = it.x2 - w / 2;
        const y = it.kind === "bull" ? it.y2 + 8 : it.y2 - 8 - h;
        if (taken.some((r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y)) {
          continue;
        }
        taken.push({ x, y, w, h });
        ctx.fillStyle = this.colors.labelBg;
        ctx.fillRect(x * hr, y * vr, w * hr, h * vr);
        ctx.fillStyle = it.kind === "bull" ? this.colors.bull : this.colors.bear;
        ctx.fillRect(x * hr, y * vr, Math.max(1, hr), h * vr);
        ctx.fillStyle = this.colors.labelInk;
        it.lines.forEach((line, i) => {
          ctx.fillText(line, (x + padX) * hr, (y + 2 + i * lineH) * vr);
        });
      }
      ctx.restore();
    });
  }
}

class PaneView implements ISeriesPrimitivePaneView {
  private items: ScreenLine[] = [];
  constructor(private readonly source: DivergenceLines) {}

  update(): void {
    const ts = this.source.chart.timeScale();
    const series = this.source.series;
    const out: ScreenLine[] = [];
    for (const d of this.source.divergences) {
      const x1 = ts.timeToCoordinate(d.fromTime as Time);
      const x2 = ts.timeToCoordinate(d.toTime as Time);
      const y1 = series.priceToCoordinate(d.fromPrice);
      const y2 = series.priceToCoordinate(d.toPrice);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      out.push({
        x1,
        y1,
        x2,
        y2,
        kind: d.kind,
        lines: this.source.showLabels ? d.indicators.map(shortIndicatorName) : [],
      });
    }
    this.items = out;
  }

  renderer(): ISeriesPrimitivePaneRenderer {
    return new Renderer(this.items, this.source.colors);
  }

  zOrder(): SeriesPrimitivePaneViewZOrder {
    return "top";
  }
}

export class DivergenceLines extends PluginBase {
  divergences: Divergence[] = [];
  showLabels = true;
  private readonly views: PaneView[];

  constructor(readonly colors: DivergenceLineColors) {
    super();
    this.views = [new PaneView(this)];
  }

  setData(divergences: Divergence[], showLabels: boolean): void {
    this.divergences = divergences;
    this.showLabels = showLabels;
    this.requestUpdate();
  }

  updateAllViews(): void {
    this.views.forEach((v) => v.update());
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return this.views;
  }
}

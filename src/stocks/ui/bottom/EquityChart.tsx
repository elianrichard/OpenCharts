import { useEffect, useMemo, useRef, useState } from "react";
import { fmtDay, fmtMoney } from "../format.ts";

/**
 * Closed-trade equity as a step-free line, with a y-scale on the right, year
 * ticks under it and the starting capital as a dashed baseline. One series,
 * so no legend; the line carries the workspace's one data hue.
 */

const PAD = { top: 10, right: 64, bottom: 22, left: 8 };

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n >= 5 ? 10 : n >= 2 ? 5 : n >= 1 ? 2 : 1) * mag;
}

export function EquityChart({
  points,
  baseline,
}: {
  points: { time: number; value: number }[];
  baseline: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (points.length < 2 || size.w < 40 || size.h < 40) return null;
    const t0 = points[0]!.time;
    const t1 = points[points.length - 1]!.time;
    const values = [...points.map((p) => p.value), baseline];
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (hi === lo) {
      hi += 1;
      lo -= 1;
    }
    // About one gridline per 32px of height, at least two.
    const step = niceStep(hi - lo, Math.max(2, Math.floor((size.h - PAD.top - PAD.bottom) / 32)));
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const iw = size.w - PAD.left - PAD.right;
    const ih = size.h - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * iw;
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * ih;
    const yTicks: number[] = [];
    for (let v = lo; v <= hi + step / 2; v += step) yTicks.push(v);
    const years: { t: number; label: string }[] = [];
    const firstYear = new Date(t0 * 1000).getUTCFullYear() + 1;
    const lastYear = new Date(t1 * 1000).getUTCFullYear();
    const every = Math.max(1, Math.ceil((lastYear - firstYear + 1) / Math.max(1, Math.floor(iw / 70))));
    for (let yr = firstYear; yr <= lastYear; yr += every) {
      years.push({ t: Date.UTC(yr, 0, 1) / 1000, label: String(yr) });
    }
    const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.time).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
    return { x, y, yTicks, years, d, iw };
  }, [points, baseline, size]);

  const hp = hover != null ? points[hover] : undefined;

  return (
    <div
      ref={ref}
      className="relative h-full w-full"
      onMouseLeave={() => setHover(null)}
      onMouseMove={(e) => {
        if (!geo) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        let best = 0;
        let bestD = Infinity;
        points.forEach((p, i) => {
          const dd = Math.abs(geo.x(p.time) - mx);
          if (dd < bestD) {
            bestD = dd;
            best = i;
          }
        });
        setHover(best);
      }}
    >
      {geo ? (
        <svg width={size.w} height={size.h} role="img" aria-label="Strategy equity after each closed trade">
          {geo.yTicks.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={PAD.left + geo.iw} y1={geo.y(v)} y2={geo.y(v)} stroke="#1f1e23" />
              <text x={size.w - PAD.right + 8} y={geo.y(v) + 4} fill="#8a8c92" fontSize="11" className="num">
                {fmtMoney(v).replace(".00", "")}
              </text>
            </g>
          ))}
          {geo.years.map((yr) => (
            <text key={yr.t} x={geo.x(yr.t)} y={size.h - 6} fill="#8a8c92" fontSize="11" textAnchor="middle" className="num">
              {yr.label}
            </text>
          ))}
          <line
            x1={PAD.left}
            x2={PAD.left + geo.iw}
            y1={geo.y(baseline)}
            y2={geo.y(baseline)}
            stroke="#3a3a3e"
            strokeDasharray="4 4"
          />
          <path d={geo.d} fill="none" stroke="#4a8ad6" strokeWidth="1.75" strokeLinejoin="round" />
          {hp && (
            <g>
              <line x1={geo.x(hp.time)} x2={geo.x(hp.time)} y1={PAD.top} y2={size.h - PAD.bottom} stroke="#3a3a3e" />
              <circle cx={geo.x(hp.time)} cy={geo.y(hp.value)} r="3" fill="#4a8ad6" />
            </g>
          )}
        </svg>
      ) : (
        <div className="flex h-full items-center justify-center text-[12px] text-[var(--mute)]">
          {points.length < 2 ? "Not enough closed trades to draw equity." : ""}
        </div>
      )}
      {hp && (
        <div className="pointer-events-none absolute left-3 top-1 text-[12px]">
          <span className="num text-[var(--mute)]">{fmtDay(hp.time)}</span>{" "}
          <span className="num">{fmtMoney(hp.value)}</span>
        </div>
      )}
    </div>
  );
}

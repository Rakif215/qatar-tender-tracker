import React, { useMemo, useRef, useState, useEffect } from "react";
import { ResponsiveContainer, Treemap } from "recharts";

export const PALETTE = ["#8a1538", "#b5476a", "#c7a24a", "#5b4a50", "#2f6b4f", "#1f5f8b", "#9a5a00", "#6d3b8f", "#a3352b", "#3d7a8a", "#7a6d70", "#b98a5e", "#4a6b2f"];

export function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function Tip({ tip }) {
  if (!tip) return null;
  return (
    <div className="viz-tip" style={{ left: tip.x, top: tip.y }}>
      <b>{tip.head}</b><span>{tip.body}</span>
    </div>
  );
}
function useTip() {
  const [tip, setTip] = useState(null);
  const show = (e, head, body) => {
    const box = e.currentTarget.ownerSVGElement?.parentElement ?? e.currentTarget.parentElement;
    const r = box.getBoundingClientRect();
    setTip({ x: Math.min(e.clientX - r.left + 12, r.width - 230), y: e.clientY - r.top + 12, head, body });
  };
  return [tip, show, () => setTip(null)];
}

// Awarded value by category; click a box to filter.
export function CategoryTreemap({ rows, fmt, onPick, active }) {
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  const data = rows.filter((r) => r.value > 0).map((r, i) => ({ ...r, size: r.value, fill: PALETTE[i % PALETTE.length] }));
  const Cell = (p) => {
    const { x, y, width, height, name, value, fill, slug } = p;
    if (!name || width <= 0 || height <= 0) return null;
    const dim = active && active !== slug;
    return (
      <g style={{ cursor: "pointer" }} onClick={() => onPick?.(slug)}>
        <rect x={x} y={y} width={width} height={height} rx={6} fill={fill} opacity={dim ? 0.3 : 1} stroke="var(--surface)" strokeWidth={3} />
        {width > 96 && height > 44 && (
          <>
            <text x={x + 10} y={y + 22} fill="#fff" fontSize={13} fontWeight={600}>{name.length > width / 7.4 ? `${name.slice(0, Math.floor(width / 7.4) - 1)}…` : name}</text>
            <text x={x + 10} y={y + 40} fill="#fff" fontSize={12} opacity={0.9}>{fmt(value)} · {Math.round((value / total) * 100)}%</text>
          </>
        )}
      </g>
    );
  };
  return (
    <div className="chart" role="img" aria-label="Treemap of awarded value by category">
      <ResponsiveContainer width="100%" height={340}>
        <Treemap data={data} dataKey="size" nameKey="name" isAnimationActive={false} content={<Cell />} />
      </ResponsiveContainer>
    </div>
  );
}

// Lines from buyers (left) to suppliers (right); width = value.
export function FlowChart({ rows, fmt, onLeft, onRight }) {
  const [ref, W] = useWidth();
  const [tip, show, hide] = useTip();
  const lefts = [...new Set(rows.map((r) => r.from))];
  const rights = [...new Set(rows.map((r) => r.to))];
  const H = Math.max(320, rights.length * 26 + 30);
  const lw = Math.min(220, W * 0.3), rw = Math.min(240, W * 0.32);
  const x0 = lw + 10, x1 = W - rw - 10;
  const yl = (k) => 20 + (lefts.indexOf(k) + 0.5) * ((H - 40) / lefts.length);
  const yr = (k) => 14 + (rights.indexOf(k) + 0.5) * ((H - 28) / rights.length);
  const maxV = Math.max(...rows.map((r) => r.value), 1);
  const w = (v) => 1.5 + Math.sqrt(v / maxV) * 16;
  const color = (k) => PALETTE[lefts.indexOf(k) % PALETTE.length];
  const cut = (s, px) => (s.length > px / 6.8 ? `${s.slice(0, Math.floor(px / 6.8) - 1)}…` : s);
  return (
    <div className="chart rel" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Flows from ministries to their biggest suppliers">
        {rows.map((r, i) => {
          const a = yl(r.from), b = yr(r.to), m = (x0 + x1) / 2;
          return (
            <path key={i} d={`M${x0},${a} C${m},${a} ${m},${b} ${x1},${b}`} fill="none" stroke={color(r.from)} strokeOpacity={0.5} strokeWidth={w(r.value)}
              onMouseMove={(e) => show(e, `${r.from} → ${r.toLabel ?? r.to}`, `${fmt(r.value)} · ${r.count} contract${r.count === 1 ? "" : "s"}`)} onMouseLeave={hide} />
          );
        })}
        {lefts.map((k) => (
          <g key={k} style={{ cursor: "pointer" }} onClick={() => onLeft?.(k)}>
            <circle cx={x0} cy={yl(k)} r={5} fill={color(k)} />
            <text x={lw} y={yl(k) + 4} textAnchor="end" className="viz-lbl">{cut(k, lw)}</text>
          </g>
        ))}
        {rights.map((k) => {
          const r = rows.find((x) => x.to === k);
          return (
            <text key={k} x={x1 + 8} y={yr(k) + 4} className="viz-lbl link-ish" onClick={() => onRight?.(r.toId)}>{cut(r.toLabel ?? k, rw)}</text>
          );
        })}
      </svg>
      <Tip tip={tip} />
    </div>
  );
}

// One dot per tender: winning offer above the lowest offer, in percent (log-like scale).
export function PriceStrip({ gaps }) {
  const [ref, W] = useWidth();
  const [tip, show, hide] = useTip();
  const H = 190, l = 10, r = 16, top = 26, bot = 30;
  const max = Math.max(50, ...gaps.map((g) => g.gap));
  const sx = (v) => l + (Math.log1p(v / 5) / Math.log1p(max / 5)) * (W - l - r);
  const ticks = [];
  for (const t of [0, 10, 25, 50, 100, 200, 500, 1000].filter((v) => v <= max)) if (!ticks.length || sx(t) - sx(ticks.at(-1)) >= 44) ticks.push(t);
  const lowest = gaps.filter((g) => g.gap < 0.01).length;
  return (
    <div className="chart rel" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="How far the winning offer was above the lowest offer, per tender">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={sx(t)} x2={sx(t)} y1={top} y2={H - bot} stroke="var(--grid)" />
            <text x={sx(t)} y={H - 10} textAnchor="middle" className="viz-axis">{t}%</text>
          </g>
        ))}
        {gaps.map((g, i) => (
          <circle key={i} cx={sx(g.gap)} cy={top + 10 + ((i * 37) % (H - top - bot - 20))} r={4.5}
            fill={g.gap < 0.01 ? "var(--accent)" : "#c7a24a"} fillOpacity={0.75}
            onMouseMove={(e) => show(e, `Tender ${g.no}`, g.gap < 0.01 ? "The lowest offer won" : `Winner ${g.gap.toFixed(1)}% above the lowest offer`)} onMouseLeave={hide} />
        ))}
        <text x={l} y={14} className="viz-lbl">{lowest} of {gaps.length} tenders went to the lowest offer (left column)</text>
      </svg>
      <Tip tip={tip} />
    </div>
  );
}

// 0–100% bars with a label at the end.
export function ShareBars({ rows, onPick }) {
  return (
    <ul className="sharebars">
      {rows.map((r) => (
        <li key={r.key}>
          <button type="button" onClick={() => onPick?.(r.key)}>
            <span className="sb-name">{r.label}</span>
            <span className="sb-val">{Math.round(r.share * 100)}%</span>
            <span className="sb-track"><i style={{ width: `${Math.round(r.share * 100)}%` }} /></span>
            {r.sub && <small>{r.sub}</small>}
          </button>
        </li>
      ))}
    </ul>
  );
}

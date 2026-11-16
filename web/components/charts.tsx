'use client';
import { useState, type ReactNode } from 'react';
import { compact, full, monthLong, monthShort } from '@/lib/insights';

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return <div className="legend">{items.map((i) => <span key={i.label}><i style={{ background: i.color }} />{i.label}</span>)}</div>;
}

export function ChartCard({ title, note, children, wide }: { title: string; note?: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`panel chart ${wide ? 'wide' : ''}`}>
      <h2>{title}</h2>
      {note && <p className="hint">{note}</p>}
      {children}
    </section>
  );
}

export function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="tile"><div className="tile-label">{label}</div><div className="tile-value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>;
}

/** Ranked horizontal bars: one hue, identity carried by the row label. */
export function BarList({ rows, unit }: { rows: { key: string | number; label: ReactNode; value: number; hint?: string }[]; unit: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="barlist">
      {rows.map((r) => (
        <div className="barlist-row" key={r.key} title={`${r.hint ?? ''}${full(r.value)} ${unit}`}>
          <div className="barlist-label">{r.label}</div>
          <div className="barlist-track"><span style={{ width: `${(r.value / max) * 100}%` }} /></div>
          <div className="barlist-value">{compact(r.value)}</div>
        </div>
      ))}
    </div>
  );
}

/** One whole split into parts (share of a company's posts). Parts keep a fixed colour order. */
export function SegmentBars({ rows, parts }: { rows: { key: number; label: ReactNode; values: number[] }[]; parts: { label: string; color: string }[] }) {
  return (
    <div className="barlist">
      {rows.map((r) => {
        const total = r.values.reduce((a, b) => a + b, 0);
        return (
          <div className="barlist-row" key={r.key}>
            <div className="barlist-label">{r.label}</div>
            <div className="segbar">
              {total ? r.values.map((v, i) => v > 0 && (
                <span key={parts[i].label} style={{ flexGrow: v, background: parts[i].color }} title={`${parts[i].label}: ${full(v)} posts (${Math.round((v / total) * 100)}%)`} />
              )) : <em />}
            </div>
            <div className="barlist-value">{compact(total)}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Companies by months: darker = more. The leader of each month is ringed. */
export function Heatmap({ months, rows, unit }: { months: string[]; rows: { key: number; label: ReactNode; name: string; values: number[] }[]; unit: string }) {
  const max = Math.max(1, ...rows.flatMap((r) => r.values));
  const leaders = months.map((_, i) => {
    const top = Math.max(...rows.map((r) => r.values[i]));
    return top > 0 ? rows.find((r) => r.values[i] === top)! : null;
  });
  const cols = { gridTemplateColumns: `minmax(150px, 1.4fr) repeat(${months.length}, minmax(34px, 1fr))` };
  return (
    <div className="scroll">
      <div className="heat" style={cols}>
        <div />
        {months.map((m) => <div className="heat-head" key={m}>{monthShort(m)}</div>)}
        {rows.map((r) => (
          <div className="heat-row" key={r.key} style={{ display: 'contents' }}>
            <div className="heat-label">{r.label}</div>
            {r.values.map((v, i) => (
              <div key={months[i]} className={`heat-cell ${leaders[i]?.key === r.key ? 'lead' : ''}`}
                style={{ background: v ? `color-mix(in oklab, var(--series-1) ${Math.round(12 + 88 * (v / max))}%, var(--panel))` : undefined }}
                title={`${r.name} · ${monthLong(months[i])}: ${full(v)} ${unit}${leaders[i]?.key === r.key ? ' — leader this month' : ''}`} />
            ))}
          </div>
        ))}
        <div className="heat-label muted">Leader</div>
        {leaders.map((l, i) => <div className="heat-leader" key={months[i]} title={l ? `${l.name} led ${monthLong(months[i])}` : 'No data'}>{l ? l.name : '—'}</div>)}
      </div>
      <div className="heat-scale"><span>Less</span><i /><span>More</span><b className="heat-cell lead" /> <span>Leader of the month</span></div>
    </div>
  );
}

const W = 240, H = 84, PAD = 6;

/** A small line chart; used as small multiples on one shared scale. */
export function MiniLine({ months, values, max, unit }: { months: string[]; values: number[]; max: number; unit: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(1, months.length - 1);
  const y = (v: number) => H - PAD - (v / Math.max(1, max)) * (H - 2 * PAD);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values.length - 1;
  const at = hover ?? last;
  return (
    <div className="mini">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Monthly ${unit}: ${values.map((v, i) => `${monthShort(months[i])} ${compact(v)}`).join(', ')}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const rel = ((e.clientX - box.left) / box.width) * W;
          setHover(Math.max(0, Math.min(last, Math.round(((rel - PAD) / (W - 2 * PAD)) * last))));
        }}>
        <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} className="axis" />
        <path d={`${line} L${x(last)},${H - PAD} L${x(0)},${H - PAD} Z`} className="area" />
        <path d={line} className="line" />
        {hover !== null && <line x1={x(at)} x2={x(at)} y1={PAD} y2={H - PAD} className="cross" />}
        <circle cx={x(at)} cy={y(values[at])} r={4} className="dot" />
      </svg>
      <div className="mini-read"><span>{monthShort(months[at])}</span><b>{compact(values[at])}</b></div>
    </div>
  );
}

/** Monthly columns, optionally stacked. One y-axis, clean ticks, hover readout per month. */
export function Columns({ months, series, unit, wide }: { months: string[]; series: { label: string; color: string; values: number[] }[]; unit: string; wide?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = months.map((_, i) => series.reduce((n, s) => n + s.values[i], 0));
  const rawMax = Math.max(1, ...totals);
  const step = 10 ** Math.floor(Math.log10(rawMax));
  const nice = [1, 2, 2.5, 5, 10].map((k) => k * step).find((k) => k >= rawMax) ?? rawMax;
  // the drawing is sized to the space it gets, so bars keep their thickness and text its size
  const width = wide ? 1120 : 540, height = wide ? 260 : 240, left = 46, bottom = 24, top = 10;
  const band = (width - left) / months.length;
  const bar = Math.min(24, band * 0.6);
  const y = (v: number) => top + (1 - v / nice) * (height - top - bottom);
  return (
    <div className="columns">
      {series.length > 1 && <Legend items={series} />}
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Monthly ${unit}`} onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={left} x2={width} y1={y(nice * t)} y2={y(nice * t)} className="axis" />
            <text x={left - 6} y={y(nice * t) + 4} textAnchor="end" className="tick">{compact(nice * t)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          let acc = 0;
          const cx = left + band * i + band / 2;
          const live = series.filter((s) => s.values[i] > 0);
          return (
            <g key={m} onMouseEnter={() => setHover(i)}>
              <rect x={left + band * i} y={top} width={band} height={height - top - bottom} fill="transparent" />
              {series.map((s) => {
                const v = s.values[i];
                if (!v) return null;
                const y0 = y(acc), y1 = y(acc + v);
                acc += v;
                const isTop = s === live[live.length - 1];
                const h = Math.max(1, y0 - y1 - (isTop ? 0 : 2)); // 2px surface gap between stacked segments
                const r = isTop ? Math.min(4, h) : 0;
                const yy = y0 - h;
                return <path key={s.label} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.45}
                  d={`M${cx - bar / 2},${y0} V${yy + r} Q${cx - bar / 2},${yy} ${cx - bar / 2 + r},${yy} H${cx + bar / 2 - r} Q${cx + bar / 2},${yy} ${cx + bar / 2},${yy + r} V${y0} Z`} />;
              })}
              <text x={cx} y={height - 6} textAnchor="middle" className="tick">{monthShort(m)}</text>
            </g>
          );
        })}
      </svg>
      <div className="readout">
        {hover === null ? <span className="muted">Hover a month for exact numbers</span> : (
          <>
            <b>{monthLong(months[hover])}</b>
            {series.map((s) => <span key={s.label}><i style={{ background: s.color }} />{series.length > 1 ? `${s.label}: ` : ''}{full(s.values[hover])}</span>)}
            {series.length > 1 && <span>Total: {full(totals[hover])} {unit}</span>}
          </>
        )}
      </div>
    </div>
  );
}

'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { CATEGORIES, FORMATS, METRICS, PROFILE_PLATFORMS, byMonth, compact, metricLabel, pct, sum, type MetricId, type ProfilePlatform } from '@/lib/insights';
import { BarList, ChartCard, Columns, Tile } from './charts';
import PostList from './PostList';
import { useSummary } from './useSummary';

export default function CompanyInsights({ id }: { id: number }) {
  const { data, error, load, working, version } = useSummary();
  const [platform, setPlatform] = useState<'' | ProfilePlatform>('');
  const [metric, setMetric] = useState<MetricId>('views');
  const [busy, setBusy] = useState(false);
  const company = data?.companies.find((c) => c.id === id);
  const months = data?.months ?? [];
  const all = useMemo(() => (data?.rows ?? []).filter((r) => !platform || r.platform === platform), [data, platform]);
  const rows = useMemo(() => all.filter((r) => r.companyId === id), [all, id]);
  const unit = metricLabel(metric).toLowerCase();

  // where this company stands among the others on the chosen measure
  const standing = useMemo(() => {
    const totals = (data?.companies ?? []).map((c) => ({ c, total: sum(all.filter((r) => r.companyId === c.id), metric) })).filter((x) => x.total > 0).sort((a, b) => b.total - a.total);
    return { totals, rank: totals.findIndex((x) => x.c.id === id) + 1 };
  }, [data, all, metric, id]);

  if (data && !company) return <div className="wrap"><div className="panel empty"><h3>This company no longer exists.</h3><p><Link className="btn small" href="/insights">← Brand analysis</Link></p></div></div>;
  const handles = PROFILE_PLATFORMS.filter((p) => company?.handles[p.id]);
  const collecting = handles.some((p) => ['queued', 'running'].includes(company!.handles[p.id]!.status));

  async function run() {
    setBusy(true);
    await fetch('/api/insights/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyId: id }) });
    await load();
    setBusy(false);
  }

  return (
    <div className="wrap">
      <header className="top">
        <Link className="btn small" href="/insights">← Brand analysis</Link>
        <div className="brand">{company?.name ?? '…'}</div>
        <div className="spacer" />
        <button className="btn primary" disabled={busy || !handles.length || collecting || working > 0} onClick={run}>{collecting ? 'Collecting…' : 'Collect this company now'}</button>
      </header>
      {error && <p className="note bad">{error}</p>}
      {data?.demo && <div className="banner">Sample-data mode is on. Everything shown is generated placeholder data, not real accounts.</div>}

      {company && (
        <div className="chips" style={{ marginBottom: 16 }}>
          {handles.length ? handles.map((p) => {
            const h = company.handles[p.id]!;
            return <a key={p.id} className="chip" href={h.url} target="_blank" rel="noopener noreferrer" title={h.error ?? undefined}>
              <span className={`dot ${h.status === 'idle' || h.status === 'queued' ? '' : h.status}`} />{p.label} <b>{h.handle}</b>{h.followers ? ` · ${compact(h.followers)} followers` : ''}{h.status === 'failed' ? ' · failed' : ''} ↗
            </a>;
          }) : <span className="muted">No official handles saved for this company. Add them on the Brand analysis page.</span>}
        </div>
      )}
      {company && handles.filter((p) => company.handles[p.id]!.status === 'failed').map((p) => <p key={p.id} className="note bad" style={{ marginBottom: 12 }}>{p.label}: {company.handles[p.id]!.error}</p>)}

      {data && !rows.length && !platform ? (
        <div className="panel empty"><h3>No data collected for this company yet</h3><p>{handles.length ? 'Press Collect this company now.' : 'Save its handles first.'}</p></div>
      ) : data && (
        <>
          <div className="filters">
            <div className="seg" role="group" aria-label="Platform">
              <button className={platform === '' ? 'on' : ''} onClick={() => setPlatform('')}>All platforms</button>
              {handles.map((p) => <button key={p.id} className={platform === p.id ? 'on' : ''} onClick={() => setPlatform(p.id)}>{p.label}</button>)}
            </div>
            <label className="sort">Measure
              <select className="input" value={metric} onChange={(e) => setMetric(e.target.value as MetricId)}>
                {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
          </div>

          <div className="tiles">
            <Tile label="Posts, last 12 months" value={compact(sum(rows, 'posts'))} />
            <Tile label="Views" value={compact(sum(rows, 'views'))} />
            <Tile label="Likes" value={compact(sum(rows, 'likes'))} />
            <Tile label="Comments" value={compact(sum(rows, 'comments'))} />
            <Tile label="Engagement / views" value={pct(sum(rows, 'engagement'), sum(rows, 'views'))} />
            <Tile label={`Rank on ${unit}`} value={standing.rank ? `#${standing.rank}` : '—'} sub={standing.rank ? `of ${standing.totals.length} companies` : undefined} />
          </div>

          <div className="grid2">
            <ChartCard wide title={`Monthly ${unit}`}>
              <Columns wide months={months} unit={unit} series={[{ label: metricLabel(metric), color: 'var(--series-1)', values: byMonth(rows, months, metric) }]} />
            </ChartCard>
            <ChartCard title="Posts per month by format">
              <Columns months={months} unit="posts" series={FORMATS.map((f) => ({ label: f.label, color: f.color, values: byMonth(rows.filter((r) => r.format === f.id), months, 'posts') }))} />
            </ChartCard>
            <ChartCard title="Posts per month by kind" note="Likely promoted is an estimate; see the Brand analysis page for how it is judged.">
              <Columns months={months} unit="posts" series={CATEGORIES.map((c) => ({ label: c.label, color: c.color, values: byMonth(rows.filter((r) => r.category === c.id), months, 'posts') }))} />
            </ChartCard>
            <ChartCard title={`${metricLabel(metric)} by format`}>
              <BarList unit={unit} rows={FORMATS.map((f) => ({ key: f.id, label: f.label, value: sum(rows.filter((r) => r.format === f.id), metric) })).filter((r) => r.value > 0)} />
            </ChartCard>
            <ChartCard title={`${metricLabel(metric)} against the other companies`}>
              <BarList unit={unit} rows={standing.totals.map((x) => ({ key: x.c.id, label: x.c.id === id ? <b>{x.c.name}</b> : <Link href={`/insights/c/${x.c.id}`}>{x.c.name}</Link>, value: x.total }))} />
            </ChartCard>
          </div>

          <div style={{ marginTop: 16 }}><PostList companies={data.companies} months={months} fixedCompany={id} platform={platform} version={version} /></div>
        </>
      )}
    </div>
  );
}

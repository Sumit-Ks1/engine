'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { CATEGORIES, FORMATS, METRICS, PROFILE_PLATFORMS, byMonth, compact, full, metricLabel, pct, sum, type CompanyInfo, type MetricId, type ProfilePlatform } from '@/lib/insights';
import { BarList, ChartCard, Heatmap, Legend, MiniLine, SegmentBars } from './charts';
import PostList from './PostList';
import { useSummary } from './useSummary';

const STATUS: Record<string, string> = { idle: 'Not collected', queued: 'Waiting', running: 'Collecting…', done: 'Collected', failed: 'Failed' };

function HandleRow({ company, onSaved }: { company: CompanyInfo; onSaved: () => void }) {
  const initial = { website: company.website ?? '', ...Object.fromEntries(PROFILE_PLATFORMS.map((p) => [p.id, company.handles[p.id]?.handle ?? ''])) } as Record<ProfilePlatform | 'website', string>;
  const [v, setV] = useState(initial);
  const [msg, setMsg] = useState('');
  const dirty = (['website', ...PROFILE_PLATFORMS.map((p) => p.id)] as const).some((k) => v[k].trim() !== initial[k]);
  async function save() {
    const res = await fetch(`/api/companies/${company.id}/handles`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });
    setMsg(res.ok ? '' : (await res.json().catch(() => ({}))).error ?? 'Could not save.');
    onSaved();
  }
  return (
    <tr>
      <td><Link className="kw" href={`/insights/c/${company.id}`}>{company.name}</Link></td>
      <td>
        <input className="input" aria-label={`${company.name} website`} placeholder="brand website" value={v.website} onChange={(e) => setV({ ...v, website: e.target.value })} />
        {company.lookup?.state && <div className="sub" style={{ maxWidth: 240 }}>
          {company.lookup.state === 'queued' ? 'Waiting to read the website' : company.lookup.state === 'running' ? 'Reading the website…' : company.lookup.note}
        </div>}
      </td>
      {PROFILE_PLATFORMS.map((p) => {
        const h = company.handles[p.id];
        return (
          <td key={p.id}>
            <input className="input" aria-label={`${company.name} on ${p.label}`} placeholder="found automatically" value={v[p.id]} onChange={(e) => setV({ ...v, [p.id]: e.target.value })} />
            {h && <div className="sub" title={h.error ?? undefined}>
              <span className={`dot ${h.status === 'queued' ? '' : h.status === 'idle' ? '' : h.status}`} style={{ display: 'inline-block', marginRight: 5 }} />
              {h.source === 'auto' ? 'From website · ' : ''}{STATUS[h.status]}{h.status === 'failed' && h.error ? `: ${h.error.slice(0, 90)}` : h.followers ? ` · ${compact(h.followers)} followers` : ''}
            </div>}
          </td>
        );
      })}
      <td><button className="btn small" disabled={!dirty} onClick={save}>Save</button>{msg && <div className="note bad">{msg}</div>}</td>
    </tr>
  );
}

export default function Insights() {
  const { data, error, load, working, lookups, total, version } = useSummary();
  const canRun = (data?.companies ?? []).some((c) => c.website || Object.keys(c.handles).length);
  const [platform, setPlatform] = useState<'' | ProfilePlatform>('');
  const [metric, setMetric] = useState<MetricId>('views');
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => !platform || r.platform === platform), [data, platform]);
  const companies = data?.companies ?? [];
  const months = data?.months ?? [];
  const per = useMemo(() => companies.map((c) => {
    const mine = rows.filter((r) => r.companyId === c.id);
    return { company: c, rows: mine, total: sum(mine, metric), monthly: byMonth(mine, months, metric) };
  }), [companies, rows, months, metric]);
  const active = per.filter((p) => p.rows.length);
  const ranked = [...active].sort((a, b) => b.total - a.total);
  const unit = metricLabel(metric).toLowerCase();
  const link = (c: CompanyInfo) => <Link href={`/insights/c/${c.id}`}>{c.name}</Link>;
  const lastRun = Math.max(0, ...companies.flatMap((c) => Object.values(c.handles).map((h) => h!.fetchedAt ?? 0)));

  async function run(path: 'run' | 'stop') {
    setBusy(true);
    await fetch(`/api/insights/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await load();
    setBusy(false);
  }

  return (
    <div className="wrap">
      <header className="top">
        <Link className="btn small" href="/">← All companies</Link>
        <div className="brand">Brand analysis</div>
        <div className="spacer" />
        <span className="muted">{lookups ? `Finding official accounts… ${lookups} ${lookups === 1 ? 'website' : 'websites'} left` : working ? `Collecting… ${total - working} of ${total} accounts done` : lastRun ? `Last collected ${new Date(lastRun).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}</span>
        {working > 0 && <button className="btn small" disabled={busy} onClick={() => run('stop')}>Stop waiting ones</button>}
        <button className="btn primary" disabled={busy || !canRun || working > 0} onClick={() => run('run')}>{working ? 'Collecting…' : 'Collect now'}</button>
      </header>
      {error && <p className="note bad">{error}</p>}
      {data?.demo && <div className="banner">Sample-data mode is on. Everything shown is generated placeholder data, not real accounts.</div>}

      <details className="panel">
        <summary>Official accounts ({total} found)</summary>
        <p className="hint" style={{ marginTop: 0 }}>You do not need to fill anything in. When you press Collect now, the engine opens each brand's website, reads its official Instagram, YouTube and X links from the page, and then reads the last 12 months of each account. Check the accounts it found here; type over one to correct it, or add one the website does not link.</p>
        <div className="scroll">
          <table className="handles">
            <thead><tr><th>Company</th><th>Website</th>{PROFILE_PLATFORMS.map((p) => <th key={p.id}>{p.label}</th>)}<th /></tr></thead>
            <tbody>{companies.map((c) => <HandleRow key={`${c.id}:${c.website}:${PROFILE_PLATFORMS.map((p) => c.handles[p.id]?.handle ?? '').join('|')}`} company={c} onSaved={load} />)}</tbody>
          </table>
        </div>
      </details>

      {data && !(data.rows.length) ? (
        <div className="panel empty"><h3>{working ? 'Collecting…' : 'No brand data yet'}</h3><p>{working ? 'Charts appear here as each account finishes.' : 'Press Collect now. The engine finds each company\'s official accounts and reads the last 12 months.'}</p></div>
      ) : data && (
        <>
          <div className="filters">
            <div className="seg" role="group" aria-label="Platform">
              <button className={platform === '' ? 'on' : ''} onClick={() => setPlatform('')}>All platforms</button>
              {PROFILE_PLATFORMS.map((p) => <button key={p.id} className={platform === p.id ? 'on' : ''} onClick={() => setPlatform(p.id)}>{p.label}</button>)}
            </div>
            <label className="sort">Measure
              <select className="input" value={metric} onChange={(e) => setMetric(e.target.value as MetricId)}>
                {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
          </div>

          <div className="grid2">
            <ChartCard title={`Who leads on ${unit}`} note="Total over the last 12 months.">
              <BarList unit={unit} rows={ranked.map((p) => ({ key: p.company.id, label: link(p.company), value: p.total }))} />
            </ChartCard>

            <ChartCard title="What each company posts" note="Share of posts by format.">
              <Legend items={FORMATS} />
              <SegmentBars parts={FORMATS} rows={ranked.map((p) => ({ key: p.company.id, label: link(p.company), values: FORMATS.map((f) => sum(p.rows.filter((r) => r.format === f.id), 'posts')) }))} />
            </ChartCard>

            <ChartCard wide title={`Month by month: who led on ${unit}`} note="Darker means more. The ringed cell is that month's leader.">
              <Heatmap months={months} unit={unit} rows={ranked.map((p) => ({ key: p.company.id, name: p.company.name, label: link(p.company), values: p.monthly }))} />
            </ChartCard>

            <ChartCard wide title={`Monthly ${unit} per company`} note="Every chart uses the same scale, so heights compare directly. Hover for a month's value.">
              <div className="multiples">
                {ranked.map((p) => (
                  <div key={p.company.id}>
                    <h3>{link(p.company)}</h3>
                    <MiniLine months={months} values={p.monthly} max={Math.max(1, ...ranked.flatMap((x) => x.monthly))} unit={unit} />
                  </div>
                ))}
              </div>
            </ChartCard>

            <ChartCard wide title="Own posts, collaborations and likely promoted posts" note="Collaboration = the platform's own co-author or paid-partnership label. Likely promoted is an estimate: very high reach with almost no engagement. Platforms do not mark a brand's own ads on its profile.">
              <Legend items={CATEGORIES} />
              <SegmentBars parts={CATEGORIES} rows={ranked.map((p) => ({ key: p.company.id, label: link(p.company), values: CATEGORIES.map((c) => sum(p.rows.filter((r) => r.category === c.id), 'posts')) }))} />
            </ChartCard>
          </div>

          <details className="panel" style={{ marginTop: 16 }}>
            <summary>Table view</summary>
            <div className="scroll">
              <table>
                <thead><tr><th>Company</th><th className="num">Posts</th><th className="num">Views</th><th className="num">Likes</th><th className="num">Comments</th><th className="num">Engagement / views</th><th className="num">Collaborations</th><th className="num">Likely promoted (est.)</th><th className="num">Followers</th></tr></thead>
                <tbody>
                  {ranked.map((p) => {
                    const followers = PROFILE_PLATFORMS.filter((x) => !platform || x.id === platform).reduce((n, x) => n + (p.company.handles[x.id]?.followers ?? 0), 0);
                    return (
                      <tr key={p.company.id}>
                        <td>{link(p.company)}</td>
                        <td className="num">{full(sum(p.rows, 'posts'))}</td><td className="num">{full(sum(p.rows, 'views'))}</td>
                        <td className="num">{full(sum(p.rows, 'likes'))}</td><td className="num">{full(sum(p.rows, 'comments'))}</td>
                        <td className="num">{pct(sum(p.rows, 'engagement'), sum(p.rows, 'views'))}</td>
                        <td className="num">{full(sum(p.rows, 'collaboration'))}</td><td className="num">{full(sum(p.rows, 'promoted_est'))}</td>
                        <td className="num">{followers ? full(followers) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>

          <div style={{ marginTop: 16 }}><PostList companies={companies} months={months} platform={platform} version={version} /></div>
        </>
      )}
    </div>
  );
}

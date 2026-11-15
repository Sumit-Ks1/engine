'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { METRICS, PLATFORMS, type Accounts, type Item, type PlatformId, type PlatformState } from '@/lib/types';
import { AccountNotices, dotClass, stateLabel } from './Dashboard';

interface Detail { accounts?: Accounts; keyword: { id: number; term: string }; platforms: Partial<Record<PlatformId, PlatformState>>; items?: Item[] }

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('en-IN');
const Num = ({ v }: { v?: number | null }) => (v === null || v === undefined ? <span className="muted">—</span> : <span title={full.format(v)}>{compact.format(v)}</span>);

function ago(ts?: number | string | null) {
  if (!ts) return '';
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)}h ago`;
  if (mins < 60 * 24 * 60) return `${Math.round(mins / 1440)}d ago`;
  return new Date(ts).toLocaleDateString('en-IN', { year: 'numeric', month: 'short' });
}

export default function KeywordView({ id, initialPlatform, companyId }: { id: string; initialPlatform?: string; companyId?: string }) {
  const [platform, setPlatform] = useState<PlatformId>(PLATFORMS.find((p) => p.id === initialPlatform)?.id ?? 'youtube');
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/keywords/${id}?platform=${platform}`);
    if (res.status === 401) { window.location.href = '/login'; return; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(res.status === 404 ? 'This keyword no longer exists.' : body.error ?? 'Could not load results.'); return; }
    const stats = await fetch('/api/stats').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    setError(''); setData({ ...body, accounts: stats?.accounts });
  }, [id, platform]);

  const state = data?.platforms[platform];
  const working = state?.status === 'queued' || state?.status === 'running';
  useEffect(() => { setData((d) => (d ? { ...d, items: undefined } : d)); void load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(load, working ? 3000 : 20000);
    return () => clearInterval(timer);
  }, [load, working]);

  function pick(p: PlatformId) {
    setPlatform(p);
    window.history.replaceState(null, '', `/k/${id}?${companyId ? `c=${companyId}&` : ''}p=${p}`);
  }
  async function refresh() {
    setBusy(true);
    await fetch(`/api/keywords/${id}/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform }) });
    await load();
    setBusy(false);
  }
  function exportCsv() {
    const cols = ['rank', 'title', 'url', 'type', 'author', 'views', 'likes', 'comments', 'shares', 'publishedAt', 'signal'] as const;
    const esc = (v: unknown) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet apps treating scraped text as formulas
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [cols.join(','), ...(data?.items ?? []).map((it, i) => cols.map((c) => esc(c === 'rank' ? i + 1 : c === 'signal' ? it.extra?.signal : it[c])).join(','))];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
    a.download = `${data?.keyword.term ?? 'keyword'}-${platform}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const m = METRICS[platform];
  const items = data?.items ?? [];
  const label = PLATFORMS.find((p) => p.id === platform)!.label;
  return (
    <div className="wrap">
      <header className="top">
        <Link className="btn small" href={companyId ? `/c/${companyId}` : '/'}>← {companyId ? 'Keywords' : 'All companies'}</Link>
        <div className="brand">Trend Engine</div>
      </header>
      {error ? <div className="panel empty"><h3>{error}</h3></div> : (
        <>
          <h1>#{data?.keyword.term ?? '…'}</h1>
          <div className="tabs">
            {PLATFORMS.map((p) => (
              <button key={p.id} className={`tab ${p.id === platform ? 'on' : ''}`} onClick={() => pick(p.id)}>
                <span className={`dot ${dotClass(data?.platforms[p.id])}`} />{p.label} <small>{stateLabel(data?.platforms[p.id])}</small>
              </button>
            ))}
          </div>
          <AccountNotices accounts={data?.accounts} only={platform} onChange={load} />
          <section className="panel">
            <div className="toolbar">
              <span className="muted">
                {working ? (state?.status === 'running' ? `Collecting from ${label}…` : 'Waiting in the queue…')
                  : state?.fetchedAt ? `${items.length} results · updated ${ago(state.fetchedAt)}` : state ? 'No results stored yet' : 'Loading…'}
              </span>
              <div className="spacer" />
              <button className="btn small" disabled={!items.length} onClick={exportCsv}>Export CSV</button>
              <button className="btn small" disabled={busy || working} onClick={refresh}>{working ? 'Refreshing…' : 'Refresh now'}</button>
            </div>
            {state?.status === 'failed' && !data?.accounts?.[platform]?.paused && (
              <p className="note bad">
                {state.errorKind === 'blocked' ? `${label} turned the last attempt away.` : 'The last attempt did not finish.'}
                {items.length ? ' Showing the last results collected.' : ''}
                {state.error && <><br /><span className="muted">Reason: {state.error}</span></>}
              </p>
            )}
            {platform === 'google' && items.length > 0 && <p className="hint" style={{ marginBottom: 10 }}>Google has no views or likes. Shown here: the fastest-rising and most-searched related searches from Google Trends, then the stories covered by the most news outlets.</p>}
            {items.length ? (
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th className="num">#</th><th /><th>{platform === 'google' ? 'Search / story' : 'Post'}</th><th>Type</th>
                      {platform === 'google' && <th>Signal</th>}
                      {m.views && <th className="num">{m.views}</th>}
                      {m.likes && <th className="num">{m.likes}</th>}
                      {m.comments && <th className="num">{m.comments}</th>}
                      {m.shares && <th className="num">{m.shares}</th>}
                      <th>Posted</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, i) => (
                      <tr key={it.url}>
                        <td className="num muted">{i + 1}</td>
                        <td>{it.thumbnail && /^https:\/\//.test(it.thumbnail)
                          ? <img className="thumb" src={it.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                          : <span className="thumb" />}</td>
                        <td>
                          <a className="title" href={it.url} target="_blank" rel="noopener noreferrer">{it.title}</a>
                          {it.author && <div className="sub">{it.author}{it.extra?.subreddit ? ` · ${it.extra.subreddit}` : ''}{it.extra?.duration ? ` · ${it.extra.duration}` : ''}</div>}
                        </td>
                        <td><span className={`type ${it.type === 'ad' ? 'ad' : ''}`}>{it.type}</span></td>
                        {platform === 'google' && <td style={{ whiteSpace: 'nowrap' }}>{it.extra?.signal ?? '—'}</td>}
                        {m.views && <td className="num"><Num v={it.views} /></td>}
                        {m.likes && <td className="num"><Num v={it.likes} /></td>}
                        {m.comments && <td className="num"><Num v={it.comments} /></td>}
                        {m.shares && <td className="num"><Num v={it.shares} /></td>}
                        <td className="muted" style={{ whiteSpace: 'nowrap' }}>{ago(it.publishedAt) || '—'}</td>
                        <td><a className="btn small" href={it.url} target="_blank" rel="noopener noreferrer">Open ↗</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : data && !working && state?.status !== 'failed' ? (
              <div className="empty"><h3>Nothing found on {label} for this keyword</h3><p>Try Refresh now, or a broader keyword.</p></div>
            ) : !data || working ? <div className="empty">{working ? 'Results appear here as soon as collection finishes.' : 'Loading…'}</div> : null}
          </section>
        </>
      )}
    </div>
  );
}

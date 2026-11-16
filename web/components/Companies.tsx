'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Accounts } from '@/lib/types';
import { AccountNotices, call } from './Dashboard';

interface CompanyRow { id: number; name: string; keywords: number; jobs: number; finished: number; failed: number }
interface Stats { keywords: number; jobs: { queued: number; running: number; done: number; failed: number }; demo: boolean; accounts?: Accounts }

export default function Companies() {
  const [rows, setRows] = useState<CompanyRow[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([call('/api/companies'), call('/api/stats')]);
      setRows(list.companies); setStats(st); setError('');
    } catch (e) { setError((e as Error).message); setRows((r) => r ?? []); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => { await call('/api/companies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }); setName(''); });
  };
  const remove = (c: CompanyRow) => {
    const msg = c.keywords ? `Remove "${c.name}" and its ${c.keywords} keywords? Keywords another company also lists are kept.` : `Remove "${c.name}"?`;
    if (confirm(msg)) void run(() => call(`/api/companies/${c.id}`, { method: 'DELETE' }));
  };
  const logout = async () => { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/login'; };

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">Trend Engine</div>
        {stats && (
          <div className="stats">
            <span><b>{stats.keywords}</b> keywords</span>
            <span><b>{stats.jobs.done}</b> ready</span>
            <span><b>{stats.jobs.queued + stats.jobs.running}</b> in progress</span>
            <span><b>{stats.jobs.failed}</b> failed</span>
          </div>
        )}
        <div className="spacer" />
        <Link className="btn small" href="/insights">Brand analysis</Link>
        <button className="btn small" onClick={logout}>Sign out</button>
      </header>

      {stats?.demo && <div className="banner">Sample-data mode is on. Everything listed is generated placeholder data, not live results.</div>}
      <AccountNotices accounts={stats?.accounts} onChange={load} />

      <h1>Companies</h1>
      <p className="hint" style={{ margin: '-6px 0 16px' }}>Pick a company to add or view its keywords. The company name is only a label; it is never searched.</p>
      {error && <p className="note bad" style={{ marginBottom: 12 }}>{error}</p>}

      {rows === null ? <div className="panel empty">Loading…</div> : (
        <div className="cards">
          {rows.map((c) => {
            const pct = c.jobs ? Math.round((c.finished / c.jobs) * 100) : 0;
            return (
              <div className="card" key={c.id}>
                <Link href={`/c/${c.id}`} className="card-main">
                  <div className="card-name">{c.name}</div>
                  <div className="muted">{c.keywords ? `${c.keywords} ${c.keywords === 1 ? 'keyword' : 'keywords'}` : 'No keywords yet'}</div>
                  {c.jobs > 0 && (
                    <>
                      <div className="bar"><span style={{ width: `${pct}%` }} /></div>
                      <div className="sub">{pct === 100 ? 'Collected' : `Collecting… ${pct}%`}{c.failed ? ` · ${c.failed} failed` : ''}</div>
                    </>
                  )}
                </Link>
                <button className="btn small danger card-x" title={`Remove ${c.name}`} onClick={() => remove(c)}>Remove</button>
              </div>
            );
          })}
          <form className="card add" onSubmit={add}>
            <input className="input" placeholder="New company name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn primary" disabled={busy || !name.trim()}>Add company</button>
          </form>
        </div>
      )}
    </div>
  );
}

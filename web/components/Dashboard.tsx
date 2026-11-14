'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PLATFORMS, type KeywordRow, type PlatformState } from '@/lib/types';

interface Stats { keywords: number; jobs: { queued: number; running: number; done: number; failed: number }; demo: boolean; refreshHours: number }

async function call(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (res.status === 401) { window.location.href = '/login'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong.');
  return data;
}

export function dotClass(s?: PlatformState) {
  if (!s) return '';
  if (s.status === 'done' && !s.count) return 'empty';
  return s.status;
}
export function stateLabel(s?: PlatformState) {
  if (!s) return '—';
  if (s.count) return String(s.count);
  return { queued: 'queued', running: 'working', done: 'none', failed: s.errorKind === 'login_required' ? 'login wall' : 'failed' }[s.status];
}

export default function Dashboard() {
  const [rows, setRows] = useState<KeywordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([
        call(`/api/keywords?${new URLSearchParams({ search, page: String(page) })}`),
        call('/api/stats'),
      ]);
      setRows(list.keywords); setTotal(list.total); setStats(st);
      setNote((n) => (n && !n.ok && n.msg.includes('engine') ? null : n));
    } catch (e) {
      setNote({ ok: false, msg: (e as Error).message });
    } finally { setLoaded(true); }
  }, [search, page]);

  useEffect(() => {
    const first = setTimeout(load, 200);
    const timer = setInterval(load, 5000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [load]);

  const report = (r: { added: number; duplicates: number; invalid: number }) => {
    const parts = [`${r.added} added`];
    if (r.duplicates) parts.push(`${r.duplicates} already in the list`);
    if (r.invalid) parts.push(`${r.invalid} skipped (empty or longer than 100 characters)`);
    setNote({ ok: true, msg: parts.join(' · ') });
  };

  async function run(fn: () => Promise<void>) {
    setBusy(true); setNote(null);
    try { await fn(); await load(); } catch (e) { setNote({ ok: false, msg: (e as Error).message }); } finally { setBusy(false); }
  }

  const add = () => run(async () => {
    report(await call('/api/keywords', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }));
    setText('');
  });
  const upload = (file: File) => run(async () => {
    const form = new FormData();
    form.append('file', file);
    report(await call('/api/keywords/upload', { method: 'POST', body: form }));
    if (fileRef.current) fileRef.current.value = '';
  });
  const remove = (k: KeywordRow) => {
    if (confirm(`Remove "${k.term}" and its results?`)) void run(async () => { await call(`/api/keywords/${k.id}`, { method: 'DELETE' }); });
  };
  const logout = async () => { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/login'; };

  const pages = Math.max(1, Math.ceil(total / 50));
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
        <button className="btn small" onClick={logout}>Sign out</button>
      </header>

      {stats?.demo && <div className="banner">Sample-data mode is on. Everything listed is generated placeholder data, not live results.</div>}

      <section className="panel">
        <div className="row">
          <textarea className="input" rows={2} placeholder="Add keywords — separate with commas or new lines" value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) add(); }} />
          <button className="btn primary" disabled={busy || !text.trim()} onClick={add}>Add</button>
          <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>Upload sheet</button>
          <input ref={fileRef} type="file" accept=".xlsx,.csv,.txt" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </div>
        <p className="hint">Upload an .xlsx or .csv with one keyword per cell. A leading # is optional. Each keyword is collected on all six platforms{stats ? ` and refreshed every ${stats.refreshHours} hours` : ''}.</p>
        {note && <p className={`note ${note.ok ? 'ok' : 'bad'}`}>{note.msg}</p>}
      </section>

      <section className="panel">
        <div className="toolbar">
          <input className="input" style={{ maxWidth: 320 }} placeholder="Search keywords" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <span className="muted">{total} {total === 1 ? 'keyword' : 'keywords'}</span>
        </div>
        {rows.length ? (
          <div className="scroll">
            <table>
              <thead><tr><th>Keyword</th><th>Results by platform</th><th /></tr></thead>
              <tbody>
                {rows.map((k) => (
                  <tr key={k.id}>
                    <td><Link className="kw" href={`/k/${k.id}`}>#{k.term}</Link></td>
                    <td>
                      <div className="chips">
                        {PLATFORMS.map((p) => (
                          <Link key={p.id} className="chip" href={`/k/${k.id}?p=${p.id}`} title={`${p.label}: ${stateLabel(k.platforms[p.id])}`}>
                            <span className={`dot ${dotClass(k.platforms[p.id])}`} />{p.label} <b>{stateLabel(k.platforms[p.id])}</b>
                          </Link>
                        ))}
                      </div>
                    </td>
                    <td className="num"><button className="btn small danger" onClick={() => remove(k)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : loaded ? (
          <div className="empty">
            <h3>{search ? 'No keywords match that search' : 'No keywords yet'}</h3>
            {!search && <p>Add a keyword above or upload a sheet to start collecting.</p>}
          </div>
        ) : <div className="empty">Loading…</div>}
        {pages > 1 && (
          <div className="pager">
            <button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span className="muted">Page {page} of {pages}</span>
            <button className="btn small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </section>
    </div>
  );
}

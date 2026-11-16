'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PLATFORMS, labelOf, type Accounts, type KeywordRow, type PlatformState } from '@/lib/types';

interface Stats { keywords: number; jobs: { queued: number; running: number; done: number; failed: number }; demo: boolean; refreshHours: number; accounts?: Accounts }

export async function call(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (res.status === 401) { window.location.href = '/login'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong.');
  return data;
}

/** One line per signed-in platform that has stopped collecting, with the way out. */
export function AccountNotices({ accounts, only, onChange }: { accounts?: Accounts; only?: string; onChange?: () => void }) {
  const paused = Object.entries(accounts ?? {}).filter(([id, a]) => a?.paused && (!only || only === id));
  if (!paused.length) return null;
  const resume = async (id: string) => { await fetch(`/api/accounts/${id}/resume`, { method: 'POST' }); onChange?.(); };
  return (
    <>
      {paused.map(([id, a]) => (
        <div className="banner" key={id}>
          <b>{labelOf(id)} is paused.</b>{' '}
          {a!.kind === 'login'
            ? <>It is not signed in. Stop the engine, run <code>npm run login</code> in the engine folder, sign in, close the window, then start the engine again.</>
            : <>{a!.reason}{a!.until ? ` It resumes by itself around ${new Date(a!.until).toLocaleString('en-IN', { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' })}.` : ''}{' '}
              <button className="btn small" onClick={() => resume(id)}>Resume now</button></>}
        </div>
      ))}
    </>
  );
}

export function dotClass(s?: PlatformState) {
  if (!s) return '';
  if (s.status === 'done' && !s.count) return 'none';
  return s.status;
}
export function stateLabel(s?: PlatformState) {
  if (!s) return '—';
  if (s.count) return String(s.count);
  return { queued: 'queued', running: 'working', done: 'none', failed: s.errorKind === 'login_required' ? 'login wall' : 'failed' }[s.status];
}

export default function Dashboard({ companyId }: { companyId: string }) {
  const base = `/api/companies/${companyId}/keywords`;
  const [company, setCompany] = useState('');
  const [missing, setMissing] = useState(false);
  const [rows, setRows] = useState<KeywordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([
        call(`${base}?${new URLSearchParams({ search, page: String(page) })}`),
        call('/api/stats'),
      ]);
      setRows(list.keywords); setTotal(list.total); setStats(st); setCompany(list.company.name);
      setNote((n) => (n && !n.ok && n.msg.includes('engine') ? null : n));
    } catch (e) {
      if ((e as Error).message === 'not found') setMissing(true);
      else setNote({ ok: false, msg: (e as Error).message });
    } finally { setLoaded(true); }
  }, [base, search, page]);

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
    report(await call(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }));
    setText('');
  });
  const upload = (file: File) => run(async () => {
    const form = new FormData();
    form.append('file', file);
    report(await call(`${base}/upload`, { method: 'POST', body: form }));
    if (fileRef.current) fileRef.current.value = '';
  });
  const toggle = (id: number) => setPicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const allOnPage = rows.length > 0 && rows.every((k) => picked.has(k.id));
  const togglePage = () => setPicked((prev) => {
    const next = new Set(prev);
    for (const k of rows) { if (allOnPage) next.delete(k.id); else next.add(k.id); }
    return next;
  });
  const bulkRemove = (all: boolean) => {
    const count = all ? total : picked.size;
    const what = all ? `all ${count} keywords` : `${count} selected ${count === 1 ? 'keyword' : 'keywords'}`;
    if (!count || !confirm(`Remove ${what} from ${company}? Their results are deleted and any collection still in progress for them stops.`)) return;
    void run(async () => {
      const r = await call(`${base}/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(all ? { all: true } : { ids: [...picked] }) });
      setPicked(new Set()); setPage(1);
      setNote({ ok: true, msg: `${r.removed} ${r.removed === 1 ? 'keyword' : 'keywords'} removed` });
    });
  };
  const remove = (k: KeywordRow) => {
    if (confirm(`Remove "${k.term}" from ${company}?`)) void run(async () => { await call(`${base}/${k.id}`, { method: 'DELETE' }); });
  };
  const logout = async () => { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/login'; };

  const pages = Math.max(1, Math.ceil(total / 50));
  if (missing) return <div className="wrap"><div className="panel empty"><h3>This company no longer exists.</h3><p><Link className="btn small" href="/">← All companies</Link></p></div></div>;
  return (
    <div className="wrap">
      <header className="top">
        <Link className="btn small" href="/">← All companies</Link>
        <div className="brand">Trend Engine</div>
        <div className="spacer" />
        <button className="btn small" onClick={logout}>Sign out</button>
      </header>

      {stats?.demo && <div className="banner">Sample-data mode is on. Everything listed is generated placeholder data, not live results.</div>}

      <AccountNotices accounts={stats?.accounts} onChange={load} />

      <h1>{company || '…'}</h1>
      <section className="panel">
        <div className="row">
          <textarea className="input" rows={2} placeholder={`Add keywords for ${company || 'this company'} — separate with commas or new lines`} value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) add(); }} />
          <button className="btn primary" disabled={busy || !text.trim()} onClick={add}>Add</button>
          <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>Upload sheet</button>
          <input ref={fileRef} type="file" accept=".xlsx,.csv,.txt" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </div>
        <p className="hint">Upload an .xlsx or .csv with one keyword per cell. A leading # is optional. Each keyword is collected on all six platforms, one keyword at a time per platform, in the order listed.</p>
        {note && <p className={`note ${note.ok ? 'ok' : 'bad'}`}>{note.msg}</p>}
      </section>

      <section className="panel">
        <div className="toolbar">
          <input className="input" style={{ maxWidth: 320 }} placeholder="Search keywords" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <span className="muted">{total} {total === 1 ? 'keyword' : 'keywords'}{picked.size ? ` · ${picked.size} selected` : ''}</span>
          <div className="spacer" />
          <button className="btn small danger" disabled={busy || !picked.size} onClick={() => bulkRemove(false)}>Remove selected{picked.size ? ` (${picked.size})` : ''}</button>
          <button className="btn small danger" disabled={busy || !total || !!search} title={search ? 'Clear the search to remove all keywords' : undefined} onClick={() => bulkRemove(true)}>Remove all</button>
        </div>
        {rows.length ? (
          <div className="scroll">
            <table>
              <thead><tr><th className="check"><input type="checkbox" aria-label="Select all keywords on this page" checked={allOnPage} onChange={togglePage} /></th><th>Keyword</th><th>Results by platform</th><th /></tr></thead>
              <tbody>
                {rows.map((k) => (
                  <tr key={k.id}>
                    <td className="check"><input type="checkbox" aria-label={`Select ${k.term}`} checked={picked.has(k.id)} onChange={() => toggle(k.id)} /></td>
                    <td><Link className="kw" href={`/k/${k.id}?c=${companyId}`}>#{k.term}</Link></td>
                    <td>
                      <div className="chips">
                        {PLATFORMS.map((p) => (
                          <Link key={p.id} className="chip" href={`/k/${k.id}?c=${companyId}&p=${p.id}`} title={`${p.label}: ${stateLabel(k.platforms[p.id])}`}>
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
            {!search && <p>Add keywords above or upload a sheet to start collecting for {company}.</p>}
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

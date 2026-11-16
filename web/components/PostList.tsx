'use client';
import { useEffect, useState } from 'react';
import { CATEGORIES, FORMATS, PROFILE_PLATFORMS, compact, full, monthLong, type CompanyInfo, type Post } from '@/lib/insights';

const Num = ({ v }: { v?: number | null }) => (v === null || v === undefined ? <span className="muted">—</span> : <span title={full(v)}>{compact(v)}</span>);
const labelOf = (list: { id: string; label: string }[], id: string) => list.find((x) => x.id === id)?.label ?? id;

/** The posts behind the charts, each with a link to the original. */
export default function PostList({ companies, months, fixedCompany, platform, version }: { companies: CompanyInfo[]; months: string[]; fixedCompany?: number; platform: string; version: number }) {
  const [f, setF] = useState({ company: '', month: '', format: '', category: '', sort: 'views' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; posts: Post[] } | null>(null);
  const set = (patch: Partial<typeof f>) => { setF((cur) => ({ ...cur, ...patch })); setPage(1); };
  useEffect(() => { setPage(1); }, [platform]);

  useEffect(() => {
    const q = new URLSearchParams({ sort: f.sort, page: String(page) });
    const company = fixedCompany ? String(fixedCompany) : f.company;
    if (company) q.set('company', company);
    if (platform) q.set('platform', platform);
    if (f.month) q.set('month', f.month);
    if (f.format) q.set('format', f.format);
    if (f.category) q.set('category', f.category);
    let live = true;
    fetch(`/api/insights/posts?${q}`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (live && d) setData(d); }).catch(() => undefined);
    return () => { live = false; };
  }, [f, page, platform, fixedCompany, version]);

  const pages = data ? Math.max(1, Math.ceil(data.total / 50)) : 1;
  const name = (id: number) => companies.find((c) => c.id === id)?.name ?? '';
  return (
    <section className="panel" id="posts">
      <div className="toolbar">
        <h2 style={{ fontSize: 15, margin: 0 }}>Posts behind the numbers</h2>
        <span className="muted">{data ? `${full(data.total)} posts` : 'Loading…'}</span>
        <div className="spacer" />
        {!fixedCompany && (
          <select className="input sel" aria-label="Company" value={f.company} onChange={(e) => set({ company: e.target.value })}>
            <option value="">All companies</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <select className="input sel" aria-label="Month" value={f.month} onChange={(e) => set({ month: e.target.value })}>
          <option value="">All 12 months</option>
          {[...months].reverse().map((m) => <option key={m} value={m}>{monthLong(m)}</option>)}
        </select>
        <select className="input sel" aria-label="Format" value={f.format} onChange={(e) => set({ format: e.target.value })}>
          <option value="">All formats</option>
          {FORMATS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <select className="input sel" aria-label="Kind" value={f.category} onChange={(e) => set({ category: e.target.value })}>
          <option value="">All kinds</option>
          {CATEGORIES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <label className="sort">Sort by
          <select className="input" value={f.sort} onChange={(e) => set({ sort: e.target.value })}>
            <option value="views">Views</option><option value="likes">Likes</option><option value="comments">Comments</option><option value="shares">Shares</option><option value="publishedAt">Newest</option>
          </select>
        </label>
      </div>
      {data?.posts.length ? (
        <div className="scroll">
          <table>
            <thead><tr><th /><th>Post</th><th>Platform</th><th>Format</th><th>Kind</th><th className="num">Views</th><th className="num">Likes</th><th className="num">Comments</th><th>Posted</th><th /></tr></thead>
            <tbody>
              {data.posts.map((p) => (
                <tr key={`${p.platform}${p.url}`}>
                  <td>{p.thumbnail && /^https:\/\//.test(p.thumbnail)
                    ? <img className="thumb" src={p.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                    : <span className="thumb" />}</td>
                  <td>
                    <a className="title" href={p.url} target="_blank" rel="noopener noreferrer">{p.title}</a>
                    <div className="sub">{name(p.companyId)}{p.extra?.collabWith ? ` · with @${String(p.extra.collabWith).split(',').join(', @')}` : ''}{p.extra?.paidPartnership ? ' · paid partnership label' : ''}</div>
                  </td>
                  <td>{labelOf(PROFILE_PLATFORMS, p.platform)}</td>
                  <td><span className="type">{labelOf(FORMATS, p.format)}</span></td>
                  <td><span className="pill">{labelOf(CATEGORIES, p.category)}</span></td>
                  <td className="num"><Num v={p.views} /></td>
                  <td className="num"><Num v={p.likes} /></td>
                  <td className="num"><Num v={p.comments} /></td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{new Date(p.publishedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                  <td><a className="btn small" href={p.url} target="_blank" rel="noopener noreferrer">Open ↗</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : data ? <div className="empty"><h3>No posts match these filters</h3></div> : null}
      {pages > 1 && (
        <div className="pager">
          <button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted">Page {page} of {pages}</span>
          <button className="btn small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </section>
  );
}

import type { PlatformId } from './types';

/** Column headings that name a platform (compared lowercased, letters and digits only). */
const ALIASES: Record<string, PlatformId> = {
  youtube: 'youtube', yt: 'youtube', youtubeshorts: 'youtube',
  instagram: 'instagram', insta: 'instagram', ig: 'instagram',
  twitter: 'twitter', x: 'twitter', xtwitter: 'twitter', twitterx: 'twitter',
  reddit: 'reddit',
  pinterest: 'pinterest',
  google: 'google', googletrends: 'google', googlesearch: 'google',
};
const GENERIC = /^(keywords?|hashtags?|tags?|terms?|allplatforms?|all)$/;
const IGNORED = /^(sno|srno|slno|no|serial|serialno|number|notes?|remarks?|company|brand)$/;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// pure numbers are serial-number cells, not keywords
const isKeyword = (s: string) => !!s && !/^\d+$/.test(s);

export interface Entry { term: string; platforms?: PlatformId[] }

/**
 * Turns the rows of one sheet into keyword entries.
 * - If the first row names platforms (YouTube, Instagram, X, Reddit, Pinterest, Google), every
 *   keyword below a platform heading is collected on that platform only. A "Keyword" column in
 *   the same sheet still means all platforms; other columns (S.No, Notes) are skipped.
 * - Otherwise every cell is a keyword for all platforms.
 */
export function entriesFromRows(rows: string[][]): { entries: Entry[]; columns: PlatformId[] } {
  const clean = rows.map((r) => r.map((c) => (c ?? '').trim())).filter((r) => r.some(Boolean));
  if (!clean.length) return { entries: [], columns: [] };
  const header = clean[0].map(norm);
  const columns = header.map((h) => ALIASES[h] ?? null);

  if (!columns.some(Boolean)) {
    const entries = clean.flat().filter((c) => isKeyword(c) && !GENERIC.test(norm(c)) && !IGNORED.test(norm(c))).map((term) => ({ term }));
    return { entries, columns: [] };
  }

  const byTerm = new Map<string, Set<PlatformId> | 'all'>();
  for (const row of clean.slice(1)) {
    row.forEach((cell, i) => {
      if (!isKeyword(cell)) return;
      const platform = columns[i];
      if (platform) {
        const cur = byTerm.get(cell);
        if (cur !== 'all') byTerm.set(cell, (cur ?? new Set<PlatformId>()).add(platform));
      } else if (GENERIC.test(header[i] ?? '')) {
        byTerm.set(cell, 'all');
      }
    });
  }
  return {
    entries: [...byTerm].map(([term, p]) => (p === 'all' ? { term } : { term, platforms: [...p] })),
    columns: [...new Set(columns.filter((c): c is PlatformId => !!c))],
  };
}

/** Splits delimited text into rows of cells, honouring quoted cells. */
export function rowsFromText(text: string): string[][] {
  const delimiter = text.includes('\t') ? '\t' : text.split('\n', 1)[0].includes(';') && !text.split('\n', 1)[0].includes(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows;
}

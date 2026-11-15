const MULT: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
  lakh: 1e5, lakhs: 1e5, lac: 1e5, crore: 1e7, crores: 1e7, cr: 1e7,
};

/** "1,234,567 views" | "1.2M" | "3.4K likes" | "1.5 lakh" | "No views" -> number (null when unparseable). */
export function parseCount(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input) : null;
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^no\s/.test(s)) return 0;
  const m = s.match(/(\d[\d,]*(?:\.\d+)?)\s*([a-z]+)?/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = m[2] ? MULT[m[2]] ?? 1 : 1;
  return Math.round(n * mult);
}

const UNIT_MS: Record<string, number> = {
  second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6,
};

/** "2 weeks ago" | "Streamed 3 days ago" -> approximate ISO timestamp. */
export function relativeToIso(text: unknown, now = Date.now()): string | null {
  if (typeof text !== 'string') return null;
  const m = text.toLowerCase().match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (!m) return null;
  return new Date(now - Number(m[1]) * UNIT_MS[m[2]]).toISOString();
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

export const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Depth-first visit of every object in a JSON tree. Return false from fn to skip its children. */
export function walk(node: unknown, fn: (obj: Record<string, any>) => boolean | void): void {
  const stack: unknown[] = [node];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
    } else if (cur && typeof cur === 'object') {
      if (fn(cur as Record<string, any>) === false) continue;
      const vals = Object.values(cur);
      for (let i = vals.length - 1; i >= 0; i--) stack.push(vals[i]);
    }
  }
}

/** Parses the JSON object literal that follows `marker` in a page (string-aware brace matching). */
export function extractJsonAfter(html: string, marker: string): any | null {
  let from = 0;
  for (;;) {
    const at = html.indexOf(marker, from);
    if (at < 0) return null;
    const start = html.indexOf('{', at + marker.length);
    if (start < 0) return null;
    // only quotes / brackets / whitespace / "=" / ":" may sit between the marker and the object
    if (/^["'\]\s=:]*$/.test(html.slice(at + marker.length, start))) {
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < html.length; i++) {
        const c = html[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
          try { return JSON.parse(html.slice(start, i + 1)); } catch { break; }
        }
      }
    }
    from = at + marker.length;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const text = (v: any): string =>
  typeof v === 'string' ? v : v?.simpleText ?? v?.content ?? (Array.isArray(v?.runs) ? v.runs.map((r: any) => r.text).join('') : '');

/** Normalises user input: trims, drops leading '#', collapses whitespace. */
export function normalizeKeyword(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 100) return null;
  return s;
}

/** Hashtag form of a keyword: "skin care" -> "skincare". */
export const toTag = (kw: string) => kw.replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase();

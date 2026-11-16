'use client';
import { useCallback, useEffect, useState } from 'react';
import type { Summary } from '@/lib/insights';

/** Loads the brand-analysis data and keeps it fresh while a collection run is in progress. */
export function useSummary() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/insights/summary');
      if (res.status === 401) { window.location.href = '/login'; return; }
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not load the analysis.');
      setData(body); setError('');
    } catch (e) { setError((e as Error).message); }
  }, []);
  const states = (data?.companies ?? []).flatMap((c) => Object.values(c.handles));
  const lookups = (data?.companies ?? []).filter((c) => c.lookup?.state === 'queued' || c.lookup?.state === 'running').length;
  const working = states.filter((h) => h!.status === 'queued' || h!.status === 'running').length + lookups;
  useEffect(() => { void load(); const t = setInterval(load, working ? 4000 : 30000); return () => clearInterval(t); }, [load, working]);
  // a version number that changes whenever a handle finishes, so post lists reload
  const version = states.reduce((n, h) => n + (h!.fetchedAt ?? 0) % 1e6, 0);
  return { data, error, load, working, lookups, total: states.length, version };
}

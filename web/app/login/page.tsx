'use client';
import { useState } from 'react';

export default function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    if (res.ok) { window.location.href = '/'; return; }
    setError((await res.json().catch(() => ({}))).error ?? 'Sign-in failed.');
    setBusy(false);
  }

  return (
    <div className="wrap">
      <form className="panel login" onSubmit={submit}>
        <div className="brand">Trend Engine</div>
        <input className="input" type="password" placeholder="Password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn primary" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {error && <p className="note bad">{error}</p>}
      </form>
    </div>
  );
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoutePool } from '../src/http/proxy.js';

test('gateways rotate per host and blocked routes cool down', () => {
  const pool = new RoutePool([], { 'a.example': ['https://g1/p', 'https://g2/p', 'https://g3/p'] });
  const first = pool.pick('a.example');
  const second = pool.pick('a.example');
  assert.notEqual(first.id, second.id);
  pool.report('a.example', first, false);
  pool.report('a.example', second, false);
  for (let i = 0; i < 5; i++) {
    const r = pool.pick('a.example');
    assert.ok(r.id !== first.id && r.id !== second.id, 'cooling routes are skipped');
  }
  pool.report('a.example', first, true);
  const ids = new Set(Array.from({ length: 6 }, () => pool.pick('a.example').id));
  assert.ok(ids.has(first.id));
  assert.equal(pool.pick('other.example').id, 'direct');
});

test('exclude avoids routes already tried for a request', () => {
  const pool = new RoutePool(['http://127.0.0.1:1', 'http://127.0.0.1:2'], {});
  const a = pool.pick('h');
  const b = pool.pick('h', new Set([a.id]));
  assert.notEqual(a.id, b.id);
});

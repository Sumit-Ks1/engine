import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DB_PATH = ':memory:';
const lanes = await import('../src/lanes.js');

test('signed-in platforms pace themselves and pause when the platform pushes back', () => {
  assert.deepEqual(lanes.unavailable(), []);
  lanes.started('instagram');
  lanes.finished('instagram');
  assert.deepEqual(lanes.unavailable(), ['instagram'], 'gap between keywords');
  assert.equal(lanes.pauseOf('instagram'), null);

  lanes.finished('twitter', 'blocked', 'rate limited');
  assert.equal(lanes.laneStatus().twitter.kind, 'cooldown');
  assert.ok(lanes.laneStatus().twitter.until! > Date.now());

  lanes.finished('reddit', 'login_required', 'Not signed in.');
  assert.equal(lanes.laneStatus().reddit.kind, 'login');
  assert.equal(lanes.laneStatus().reddit.until, null);
  lanes.resume('reddit');
  assert.equal(lanes.laneStatus().reddit.paused, false);

  // anonymous platforms are never held back
  lanes.finished('youtube', 'blocked', 'x');
  assert.ok(!lanes.unavailable().includes('youtube'));
  assert.equal(lanes.laneStatus().instagram.usedToday, 1);
});

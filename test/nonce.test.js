import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NonceManager } from '../src/index.js';

test('concurrent leases never collide', () => {
  const n = new NonceManager();
  n.sync(7);
  assert.deepEqual([n.lease(), n.lease(), n.lease()], [7, 8, 9]);
});

test('a released nonce is reused, lowest first, so no gap blocks the queue', () => {
  const n = new NonceManager();
  n.sync(0);
  const [a, b, c] = [n.lease(), n.lease(), n.lease()];
  n.release(b);
  n.release(a);
  assert.deepEqual([n.lease(), n.lease(), n.lease()], [0, 1, 3]);
  assert.equal(c, 2);
});

test('a sent nonce cannot be released', () => {
  const n = new NonceManager();
  n.sync(0);
  n.sent(n.lease());
  assert.equal(n.release(0), false);
});

test('sync jumps forward when another process sent from the same account', () => {
  const n = new NonceManager();
  n.sync(0);
  n.sent(n.lease());
  n.sync(5);
  assert.equal(n.lease(), 5);
});

test('a dropped transaction: wait first, then reuse its nonce', () => {
  const clock = { t: 0 };
  const n = new NonceManager({ rewindAfterMs: 60_000, now: () => clock.t });
  n.sync(0);
  n.sent(n.lease());
  n.sent(n.lease());
  assert.equal(n.sync(0), 2, 'still in flight: do not reuse 0 and 1 yet');
  clock.t = 61_000;
  assert.equal(n.sync(0), 0, 'the chain never saw them: start again at 0');
  assert.equal(n.lease(), 0);
});

test('leasing before the first sync is an error, not a guess', () => {
  assert.throws(() => new NonceManager().lease(), /sync\(\)/);
});

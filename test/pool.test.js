import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { PoolExhausted, RpcPool } from '../src/index.js';
import { mockRpc } from './mock-rpc.js';

const servers = [];
after(() => Promise.all(servers.map((s) => s.close())));

async function endpoints(...specs) {
  const made = await Promise.all(specs.map((spec) => mockRpc(spec)));
  servers.push(...made);
  return made;
}

function pool(made, opts = {}, tiers = []) {
  const names = ['a', 'b', 'c', 'd'];
  return new RpcPool(made.map((m, i) => ({ url: m.url, name: names[i], tier: tiers[i] ?? 1 })), opts);
}

test('a rate-limited endpoint is banned and the call moves on inside its own tier', async () => {
  const [a, b, paid] = await endpoints({ mode: 'rate_limit' }, {}, {});
  const p = pool([a, b, paid], {}, [1, 1, 2]);
  assert.equal(await p.call('eth_call', [{}, 'latest']), '0x2a');
  assert.equal(p.lastServedBy, 'b');
  assert.equal(p.endpoints[0].banReason, 'rate_limit');
  assert.equal(paid.state.calls, 0, 'one free 429 must not spill onto the paid tier');
});

test('a spent quota that arrives as a 429 gets the long ban, and the health check revives it', async () => {
  const [a, b] = await endpoints({ mode: 'quota' }, {});
  const p = pool([a, b]);
  await p.call('eth_call', [{}, 'latest']);
  assert.equal(p.endpoints[0].banReason, 'quota');
  assert.ok(p.endpoints[0].bannedUntil - Date.now() > 60 * 60_000);
  a.state.mode = 'ok';
  await p.checkHealth();
  assert.equal(p.endpoints[0].bannedUntil, 0);
});

test('a revert is the chain answering: it is thrown at once and nobody is banned', async () => {
  const [a, b] = await endpoints({ mode: 'revert' }, {});
  const p = pool([a, b]);
  await assert.rejects(p.call('eth_call', [{}, 'latest']), /execution reverted/);
  assert.equal(b.state.calls, 0, 'every node would revert the same call');
  assert.ok(p.endpoints.every((ep) => ep.bannedUntil === 0));
});

test('one stall is noise, three in a row is a hung endpoint', async () => {
  const [a, b] = await endpoints({ mode: 'hang' }, {});
  const p = pool([a, b], { timeoutMs: 100 });
  for (let i = 0; i < 10 && !p.endpoints[0].banReason; i++) await p.call('eth_blockNumber');
  assert.equal(p.endpoints[0].banReason, 'hung');
  assert.equal(a.state.calls, 3);
});

test('an unsupported method rules out that method only', async () => {
  const [a, b] = await endpoints({ unsupported: ['debug_traceTransaction'] }, {});
  const p = pool([a, b]);
  await p.call('debug_traceTransaction', ['0x01']);
  assert.ok(p.endpoints[0].unsupported.has('debug_traceTransaction'));
  assert.equal(p.endpoints[0].bannedUntil, 0);
  for (let i = 0; i < 4; i++) await p.call('eth_blockNumber');
  assert.ok(p.endpoints[0].served > 0, 'a still serves everything else');
});

test('background calls stop at the paid budget; critical calls always get through', async () => {
  const clock = { t: 1_000_000 };
  const [free, paid] = await endpoints({ mode: 'down' }, {});
  const p = pool([free, paid], { reservedPerMinute: 2, now: () => clock.t }, [1, 2]);
  await p.call('eth_call', [{}, 'latest']);
  await p.call('eth_call', [{}, 'latest']);
  await assert.rejects(p.call('eth_call', [{}, 'latest']), (err) => err instanceof PoolExhausted && /paid budget/.test(err.message));
  assert.equal(await p.call('eth_sendRawTransaction', ['0x00'], { critical: true }), '0x2a');
  assert.equal(paid.state.calls, 3);
  assert.equal(p.reservedRefused, 1);
  clock.t += 60_000;
  assert.equal(await p.call('eth_call', [{}, 'latest']), '0x2a', 'a new minute, a new budget');
});

test('no budget means no limit, and 0 means never', async () => {
  const [free, paid] = await endpoints({ mode: 'down' }, {});
  const unlimited = pool([free, paid], { reservedPerMinute: null }, [1, 2]);
  for (let i = 0; i < 5; i++) assert.equal(await unlimited.call('eth_blockNumber'), '0x64');
  const never = pool([free, paid], { reservedPerMinute: 0 }, [1, 2]);
  await assert.rejects(never.call('eth_blockNumber'), PoolExhausted);
  assert.equal(await never.call('eth_blockNumber', [], { critical: true }), '0x64');
});

test('fast endpoints share the traffic; a slow one is only explored', async () => {
  const [a, b, slow] = await endpoints({ delayMs: 20 }, { delayMs: 20 }, { delayMs: 150 });
  const p = pool([a, b, slow]);
  for (let i = 0; i < 60; i++) await p.call('eth_blockNumber');
  const [sa, sb, ss] = p.stats();
  assert.ok(sa.served >= 15 && sb.served >= 15, `fast ones share: ${sa.served} / ${sb.served}`);
  assert.ok(ss.served <= 5, `slow one explored only: ${ss.served}`);
});

test('an endpoint behind the chain is benched until it catches up', async () => {
  const [a, b] = await endpoints({ head: 100 }, { head: 90 });
  const p = pool([a, b]);
  await p.checkHealth({ maxLagBlocks: 5 });
  assert.equal(p.endpoints[1].banReason, 'behind');
  b.state.head = 100;
  await p.checkHealth({ maxLagBlocks: 5 });
  assert.equal(p.endpoints[1].bannedUntil, 0);
});

test('when everything is banned, the pool fails fast and says who is back first', async () => {
  const [a] = await endpoints({ mode: 'rate_limit' });
  const p = pool([a]);
  await assert.rejects(p.call('eth_blockNumber'), PoolExhausted);
  await assert.rejects(p.call('eth_blockNumber'), /every endpoint is banned; soonest back: a in 60s/);
  assert.equal(a.state.calls, 1, 'no call is sent to a banned endpoint');
});

test('an empty eth_call moves on, and when every node says 0x that is the answer', async () => {
  const [a, b] = await endpoints({ mode: 'empty' }, {});
  const p = pool([a, b]);
  assert.equal(await p.call('eth_call', [{}, 'latest']), '0x2a');
  b.state.mode = 'empty';
  assert.equal(await p.call('eth_call', [{}, 'latest']), '0x');
});

test('logs name the endpoint, never its URL (the URL often holds the key)', async () => {
  const [a, b] = await endpoints({ mode: 'bad_key' }, {});
  const lines = [];
  const p = new RpcPool([{ url: `${a.url}/v2/SECRETKEY123` }, { url: b.url }], { log: (l) => lines.push(l) });
  await p.call('eth_blockNumber');
  assert.equal(p.endpoints[0].banReason, 'key');
  assert.ok(lines.length > 0 && lines.every((l) => !l.includes('SECRETKEY123')), lines.join('\n'));
});

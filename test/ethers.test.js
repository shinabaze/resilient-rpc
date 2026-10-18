import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { RpcPool } from '../src/index.js';
import { mockRpc } from './mock-rpc.js';

// ethers is optional. CI installs it; without it these tests are skipped, not failed.
const ethers = await import('ethers').catch(() => null);
const skip = ethers ? false : 'ethers is not installed (npm install --no-save ethers@6)';

const servers = [];
after(() => Promise.all(servers.map((s) => s.close())));

test('ethers reads through the pool', { skip }, async () => {
  const { PoolProvider } = await import('../src/ethers.js');
  const bad = await mockRpc({ mode: 'rate_limit' });
  const good = await mockRpc({ head: 1234 });
  servers.push(bad, good);
  const provider = new PoolProvider(new RpcPool([{ url: bad.url }, { url: good.url }]), 1);
  assert.equal(await provider.getBlockNumber(), 1234);
  provider.destroy();
});

test('a revert reaches ethers as a revert', { skip }, async () => {
  const { PoolProvider } = await import('../src/ethers.js');
  const node = await mockRpc({ mode: 'revert' });
  servers.push(node);
  const provider = new PoolProvider(new RpcPool([{ url: node.url }]), 1);
  await assert.rejects(provider.call({ to: '0x' + '11'.repeat(20), data: '0x' }), (err) => err.code === 'CALL_EXCEPTION');
  provider.destroy();
});

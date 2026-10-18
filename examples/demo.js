// Five local endpoints that misbehave on cue, so you can watch the pool react.
// No network, no key:  node examples/demo.js
import { RpcPool } from '../src/index.js';
import { mockRpc } from '../test/mock-rpc.js';

const quick = await mockRpc({ delayMs: 15 });
const steady = await mockRpc({ delayMs: 20 });
const slow = await mockRpc({ delayMs: 90 });
const limited = await mockRpc({ delayMs: 15 });
const paid = await mockRpc({ delayMs: 10 });
const free = [quick, steady, slow, limited];

const pool = new RpcPool([
  { url: quick.url, name: 'quick' },
  { url: steady.url, name: 'steady' },
  { url: slow.url, name: 'slow' },
  { url: limited.url, name: 'limited' },
  { url: paid.url, name: 'paid', tier: 2 },
], { reservedPerMinute: 5, log: (line) => console.log(`   log: ${line}`) });

async function background(n) {
  let refused = 0;
  for (let i = 0; i < n; i++) {
    try { await pool.call('eth_call', [{}, 'latest']); } catch { refused++; }
  }
  return refused;
}

function show() {
  console.log('   endpoint  tier  ms   served  failed  out');
  for (const s of pool.stats()) {
    console.log(`   ${s.name.padEnd(9)} ${String(s.tier).padEnd(5)} ${String(s.ms ?? '-').padEnd(4)} ${String(s.served).padEnd(7)} ${String(s.failed).padEnd(7)} ${s.out}`);
  }
}

console.log('\n1. 100 background calls, every free endpoint healthy');
await background(100);
show();

console.log('\n2. "limited" starts answering 429, 50 more calls');
limited.state.mode = 'rate_limit';
await background(50);
show();

console.log('\n3. every free endpoint goes down: 10 background calls, then 1 critical one');
for (const m of free) m.state.mode = 'down';
const refused = await background(10);
await pool.call('eth_sendRawTransaction', ['0x00'], { critical: true });
console.log(`   background: ${10 - refused} served by paid, ${refused} refused (budget: 5 a minute)`);
console.log(`   critical:   served by ${pool.lastServedBy}`);
show();

await Promise.all([...free, paid].map((m) => m.close()));

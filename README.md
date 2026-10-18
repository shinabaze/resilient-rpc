# resilient-rpc

A pool of JSON-RPC endpoints for Ethereum-style chains. It sends each call to the fastest healthy
endpoint, bans an endpoint for as long as its error says (a minute for a rate limit, hours for a
spent quota, never for a revert), and keeps your paid endpoint for the calls that matter.

About 380 lines of JavaScript, no dependencies, Node 22+. There is an optional adapter so ethers v6
can use the pool as its provider.

I built the first version for a Web3 system of mine that reads the chain all day from a mix of
free and paid endpoints. Free endpoints rate-limit, run out of quota, hang and fall behind the
chain, and each of those needs a different answer. This is that engineering on its own.

**Run it** (no network, no key: the demo and the tests start their own local endpoints):

```bash
node examples/demo.js
node --test
```

**Use it:**

```js
import { RpcPool } from './src/index.js';

const pool = new RpcPool([
  { url: process.env.RPC_FREE_1 },
  { url: process.env.RPC_FREE_2 },
  { url: process.env.RPC_PAID, tier: 2 },   // reached only when every tier 1 endpoint is out
], { reservedPerMinute: 60 });             // background calls may use it 60 times a minute

const block = await pool.call('eth_blockNumber');
await pool.call('eth_sendRawTransaction', [signedTx], { critical: true });   // never budget-limited
setInterval(() => pool.checkHealth(), 30_000);   // revives spent keys, benches lagging nodes
```

With ethers v6: `new PoolProvider(pool, chainId)` from `src/ethers.js`.

## How it works

```
call --> tier 1: fast group first (shared: whoever waited longest goes first), then the slow ones
     |     error? read what kind, ban for that long, try the next endpoint IN THE SAME TIER
     +-> tier 2 (paid): only when tier 1 is out, and for background calls only up to the budget
```

What each error means (`src/errors.js`):

| The endpoint said | Kind | What happens |
|---|---|---|
| `execution reverted`, `nonce too low` | answer | thrown to you at once, no ban: every node would say the same |
| 429, `-32005`, "rate limit" | rate_limit | out for 1 minute |
| 429 with "monthly" or "quota" | quota | out for 6 hours, or until `checkHealth()` sees it answer again |
| 401, "API key disabled" | key | out for 6 hours, same revival |
| `-32601`, "method not found" | unsupported | never asked for that method again; still used for everything else |
| `filter not found` | elsewhere | try another node, no ban (the filter lives on the node that made it) |
| no answer within `timeoutMs` | timeout | try the next one; 3 in a row bans it for a minute as hung |
| 5xx, connection refused | down | out for 30 seconds |

Every number is an option. [docs/explained.md](docs/explained.md) explains RPC pools from
scratch, and [docs/decisions.md](docs/decisions.md) gives the reason behind each rule.

## A worked example

`node examples/demo.js` runs five local endpoints. Four are free (one of them slow), one is paid
with a budget of 5 background calls a minute. Abridged output:

```
1. 100 background calls, every free endpoint healthy
   endpoint  tier  ms   served  failed  out
   quick     1     32   32      0
   steady    1     36   31      0
   slow      1     102  6       0
   limited   1     31   31      0
   paid      2     -    0       0

2. "limited" starts answering 429, 50 more calls
   log: limited: rate_limit, out for 60s

3. every free endpoint goes down: 10 background calls, then 1 critical one
   background: 5 served by paid, 5 refused (budget: 5 a minute)
   critical:   served by paid
```

The three fast endpoints share the traffic evenly. The slow one gets a call now and then, so the
pool notices if it speeds up. The paid endpoint isn't touched until the free ones are gone, and
then it serves 5 background calls and every critical one.

The repo also has a nonce manager (`src/nonce.js`) for sending many transactions from one
account: it reuses a released nonce before taking a new one, so a failed send never leaves a gap
that blocks everything after it.

## What I learned

- **A spent monthly quota looks like a rate limit.** Some providers answer an exhausted plan with
  the same 429 as a per-second limit. Banned for a minute, the endpoint came straight back,
  failed again, and stayed in rotation for the rest of the month. Read the message, not only the
  status code.
- **A retry inside the HTTP client hides the error.** The client retried 429s with backoff for
  longer than my per-call timeout, so the pool only ever saw "timeout" and never banned anything.
  One layer of retries is enough, and the pool is the one that knows about other endpoints.
- **Paid capacity runs out through background work, not the important calls.** When the free
  endpoints went down, all the background reads fell onto the paid endpoint, and the calls that
  mattered were left with nothing. A per-minute budget for anything not marked critical fixed it.

## Limits

- HTTP only. WebSocket subscriptions need their own reconnect logic, which isn't here.
- One call at a time per `call()`. It doesn't send to two endpoints at once and take the first
  answer.
- Latency is measured on your own calls plus `checkHealth()`. An endpoint you never call is
  never measured.
- The bans and budgets live in memory, so a restart forgets them. That is usually fine.

## Files

```
src/       pool.js  errors.js  nonce.js  ethers.js (optional, needs ethers v6)  index.js
test/      node:test, plus mock-rpc.js: a local endpoint you can make misbehave
examples/  demo.js
docs/      explained.md, decisions.md
```

MIT licence. Copyright 2026 Shinabaze Ajiya.

# RPC pools, explained from scratch

## What an RPC endpoint is

A blockchain app doesn't talk to the chain directly. It sends JSON to a node over HTTP, and the
node answers. That is JSON-RPC:

```json
{"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []}
{"jsonrpc": "2.0", "id": 1, "result": "0x13c4f2a"}
```

`0x13c4f2a` is the latest block number in hex (20,729,642). An endpoint is the URL of a node that
answers these. You can run your own node, use free public endpoints, or pay a provider.

## Why one endpoint isn't enough

Every endpoint fails sometimes, and they fail in different ways:

- **Rate limit.** Too many calls this second. Wait a little and it works again.
- **Quota.** The plan's calls for the month are used up. It won't work again until the month
  resets, or until someone pays.
- **Bad key.** It will never work until a person fixes the key.
- **Hang.** No answer at all. The worst one, because you wait the full timeout to find out.
- **Behind.** It answers, but its idea of the latest block is old, so its answers are out of date.

A pool holds several endpoints and moves a call to another one when the first fails. The useful
part is knowing **how long** to stop asking the one that failed. Too short and you keep paying
the cost of its failure. Too long and you run out of endpoints.

## Walk one call through by hand

Pool: `a` and `b` (free, tier 1) and `paid` (tier 2), with a budget of 5 background calls a
minute.

1. `pool.call('eth_call', ...)`. Nobody is measured yet, so `a` and `b` are both in the fast group.
   `a` has waited longest, so it goes first.
2. `a` answers HTTP 429 with "Too Many Requests". `classify` says `rate_limit`, so `a` is out for
   60 seconds. The call moves to `b`, still in tier 1.
3. `b` answers in 20 ms. Its average latency becomes 20 ms and the result goes back to you.
   `paid` was never touched.

Now say `b` goes down too. The next background call finds no tier 1 endpoint, so it goes to
`paid`, and the budget counts 1 of 5. The sixth background call that minute is refused with a
`PoolExhausted` error that says why. A call marked `{ critical: true }` still goes through.

## Measuring speed

After each answer the pool updates the endpoint's average latency with an EWMA (an exponentially
weighted moving average):

```
average = average + 0.2 * (this call - average)
```

With `0.2`, the newest call counts for a fifth, so one slow answer nudges the average and a run of
slow answers moves it properly. Endpoints within 1.5x (or 25 ms) of the best are the fast group.
The rest are only tried when the fast group fails, plus one call in every 20, so the pool notices
if a slow endpoint gets faster.

## Nonces, briefly

Every transaction from an account carries a number, the nonce: 0, 1, 2, and so on. The chain
accepts them only in order. If you send 5 transactions at once, each needs its own nonce, and if
nonce 3 fails to send, nonce 4 and everything after it are stuck until something uses 3.
`NonceManager` hands out numbers, takes back the ones that never left (`release`), and gives the
lowest one back out first, so a failed send doesn't leave a gap.

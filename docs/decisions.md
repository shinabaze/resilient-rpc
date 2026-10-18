# Decisions

Short reasons for the rules that look odd at first.

**A revert is not an endpoint failure.** `execution reverted` means the node ran the call and the
contract said no. Every other node will say the same thing, so trying them only multiplies the
cost of one bad call by the size of the pool. The error goes straight back to the caller and
nobody is banned.

**Quota is checked before rate limit.** Some providers answer a spent monthly plan with a 429,
the same status as "slow down". If that is read as a rate limit, the endpoint gets a short ban,
comes back, fails, gets a short ban, for weeks. The message decides it: "monthly", "quota" or
"capacity limit" means the long ban.

**Unsupported is per method.** A node without `debug_traceTransaction` is still a good node for
`eth_call`. Banning the whole endpoint for one missing method takes healthy capacity away from
every other call.

**A filter error moves on without a ban.** A filter is created on one node and only that node
knows it. In a pool, the next call often lands somewhere else and gets "filter not found". That
says nothing bad about the node, so it is never banned for it.

**One timeout is noise, three in a row is a hang.** A single slow answer happens to every
endpoint. But an endpoint that never answers costs the full timeout on every call that reaches
it, so after three in a row it is out for a minute.

**Failover stays inside a tier first.** One rate-limited free endpoint moves the call to the next
free endpoint, not to the paid one. Otherwise a single 429 sends background traffic straight onto
the plan you pay for.

**Paid capacity has a budget, and critical calls ignore it.** Background reads grow with your
data. Left alone, they are what drains a paid plan during an outage of the free endpoints, and
then the call that mattered has nothing left. `{ critical: true }` is for the calls that must go
through: sending a transaction, the check just before it.

**`null` means no budget, `0` means never.** `Number(null)` is `0` in JavaScript, and so is
`Number('')`. Written the obvious way, "no budget set" becomes "a budget of zero", which switches
off the paid fallback in exactly the outage it exists for. Only a real number is a budget.

**No retry inside the HTTP call.** Retrying the same struggling endpoint is worse than trying a
healthy one, and a client-side retry with backoff can outlast the timeout, turning a clear 429
into an unreadable timeout. The pool is the only layer that retries.

**The fastest group shares the work.** Sending everything to the single fastest endpoint gets it
rate-limited, and then it isn't the fastest any more. Endpoints within 1.5x (or 25 ms) of the best
take turns, oldest first.

**Logs use the endpoint's name, never its URL.** Most RPC URLs carry the API key in the path. A
log line is the easiest place for a key to leak.

**An empty `0x` from `eth_call` moves on.** A node that hasn't synced the state can answer with
nothing. If every node says `0x`, that is the real answer (no contract there, or a function that
returns nothing), and it is returned as one.

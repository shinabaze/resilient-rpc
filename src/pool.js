import { BAN_MS, PoolExhausted, RpcError, classify } from './errors.js';

const hostOf = (url) => { try { return new URL(url).host; } catch { return 'endpoint'; } };

export class RpcPool {
  /**
   * @param {{url: string, tier?: number, name?: string}[]} endpoints
   *   Lower tier = preferred. Tier 2 and up is only reached when every lower tier is out.
   * @param {object} [opts]
   *   timeoutMs          give up on one endpoint after this long (default 2000)
   *   passes             how many times to walk the whole pool before giving up (default 2)
   *   reservedFromTier   tiers at or above this are paid capacity (default 2)
   *   reservedPerMinute  how many NON-critical calls may use paid capacity a minute.
   *                      null = no limit, 0 = never. Critical calls are never limited.
   */
  constructor(endpoints, opts = {}) {
    this.endpoints = endpoints.map((e) => ({
      url: e.url,
      tier: e.tier ?? 1,
      // Logs get a name, never the URL: most RPC URLs carry the API key.
      name: e.name ?? hostOf(e.url),
      bannedUntil: 0,
      banReason: '',
      unsupported: new Set(),
      timeouts: 0,
      ewmaMs: null,
      lastUsed: 0,
      served: 0,
      failed: 0,
      head: null,
    }));
    this.timeoutMs = opts.timeoutMs ?? 2_000;
    this.passes = opts.passes ?? 2;
    this.bans = { ...BAN_MS, ...opts.bans };
    this.hangStreak = opts.hangStreak ?? 3;
    this.hangBanMs = opts.hangBanMs ?? 60_000;
    this.fastRatio = opts.fastRatio ?? 1.5;
    this.exploreEvery = opts.exploreEvery ?? 20;
    this.alpha = opts.alpha ?? 0.2;
    this.reservedFromTier = opts.reservedFromTier ?? 2;
    // Absent means unlimited. Only a real number is a budget: Number(null) is 0, and a budget of
    // 0 would switch off the paid fallback during exactly the outage it is there for.
    const budget = opts.reservedPerMinute;
    this.reservedPerMinute = typeof budget === 'number' && budget >= 0 ? budget : null;
    this.reservedUsed = 0;
    this.reservedRefused = 0;
    this.windowStart = 0;
    this.calls = 0;
    this.turn = 0;
    this.now = opts.now ?? Date.now;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.log = opts.log ?? (() => {});
    this.lastServedBy = null;   // which endpoint answered the most recent call
  }

  async call(method, params = [], { critical = false } = {}) {
    this.calls++;
    const errors = [];
    let sawEmpty = false;
    let refused = false;
    for (let pass = 0; pass < this.passes; pass++) {
      const order = this.order(method);
      if (order.length === 0) break;
      for (const ep of order) {
        if (this.isReserved(ep) && !critical && this.reservedPerMinute !== null) {
          if (!this.budgetLeft()) { refused = true; continue; }
          this.reservedUsed++;
        }
        const started = performance.now();
        try {
          const result = await this.send(ep, method, params);
          this.noteLatency(ep, performance.now() - started);
          ep.timeouts = 0;
          ep.served++;
          this.lastServedBy = ep.name;
          return result;
        } catch (err) {
          const kind = classify(err);
          if (kind === 'answer') throw err;
          if (/empty eth_call result/.test(err.message)) sawEmpty = true;
          ep.failed++;
          errors.push({ endpoint: ep.name, kind, message: String(err.message).slice(0, 160) });
          this.punish(ep, kind, method);
        }
      }
    }
    // Every node said "0x": that is the real answer (no contract, or it returns nothing).
    if (sawEmpty) return '0x';
    if (refused) this.reservedRefused++;
    const why = refused ? 'free endpoints failed and the paid budget for this minute is used up'
      : this.whyExhausted(method);
    throw new PoolExhausted(why, errors);
  }

  // The order to try endpoints in for this call: tier by tier, and within a tier the fast
  // group first. The fast group is rotated so one endpoint doesn't take every call and get
  // rate-limited for it.
  order(method) {
    const now = this.now();
    const usable = this.endpoints.filter((ep) => now >= ep.bannedUntil && !ep.unsupported.has(method));
    const tiers = [...new Set(usable.map((ep) => ep.tier))].sort((a, b) => a - b);
    const order = [];
    for (const tier of tiers) {
      const group = usable.filter((ep) => ep.tier === tier);
      const measured = group.filter((ep) => ep.ewmaMs !== null).map((ep) => ep.ewmaMs);
      const best = measured.length ? Math.min(...measured) : 0;
      // Unmeasured endpoints count as fast, so a new one gets measured straight away.
      let fast = group.filter((ep) => ep.ewmaMs === null || ep.ewmaMs <= best * this.fastRatio);
      const slow = group.filter((ep) => !fast.includes(ep)).sort((a, b) => a.ewmaMs - b.ewmaMs);
      const k = this.turn++ % fast.length;
      fast = [...fast.slice(k), ...fast.slice(0, k)];
      // Now and then, ask the least recently used slow endpoint first. Otherwise one that has
      // got faster again is never measured again.
      if (slow.length && this.calls % this.exploreEvery === 0) {
        slow.sort((a, b) => a.lastUsed - b.lastUsed);
        order.push(slow.shift());
      }
      order.push(...fast, ...slow);
    }
    return order;
  }

  isReserved(ep) {
    return ep.tier >= this.reservedFromTier;
  }

  // Paid capacity is for calls that matter. Background work (scans, refreshes, one call per
  // item in a list) grows with your data, and left alone it spends the plan in a bad hour.
  budgetLeft() {
    const now = this.now();
    if (now - this.windowStart >= 60_000) { this.windowStart = now; this.reservedUsed = 0; }
    return this.reservedUsed < this.reservedPerMinute;
  }

  async send(ep, method, params) {
    ep.lastUsed = this.now();
    let res;
    try {
      // No retry inside: if this endpoint is struggling, the next one is a better bet than
      // asking it again, and an inner retry turns a clear 429 into a vague timeout.
      res = await this.fetch(ep.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RpcError(err.name === 'TimeoutError' ? 'timeout' : String(err.cause?.code ?? err.message),
        { endpoint: ep.name });
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new RpcError(body?.error?.message ?? `HTTP ${res.status}`, { status: res.status, code: body?.error?.code, endpoint: ep.name });
    }
    if (!body || body.error) {
      const e = body?.error ?? {};
      throw new RpcError(e.message ?? 'not a JSON-RPC response', { code: e.code, data: e.data, endpoint: ep.name });
    }
    // A node that hasn't synced the state can answer an eth_call with an empty "0x".
    if (method === 'eth_call' && body.result === '0x') {
      throw new RpcError('empty eth_call result', { endpoint: ep.name });
    }
    return body.result;
  }

  punish(ep, kind, method) {
    if (kind === 'unsupported') { ep.unsupported.add(method); return; }
    if (kind === 'timeout') {
      ep.timeouts++;
      // One stall is noise. A run of them is a hung endpoint costing timeoutMs on every call.
      if (ep.timeouts >= this.hangStreak) { ep.timeouts = 0; this.ban(ep, this.hangBanMs, 'hung'); }
      return;
    }
    if (this.bans[kind]) this.ban(ep, this.bans[kind], kind);
  }

  ban(ep, ms, reason) {
    ep.bannedUntil = this.now() + ms;
    ep.banReason = reason;
    this.log(`${ep.name}: ${reason}, out for ${Math.round(ms / 1000)}s`);
  }

  noteLatency(ep, ms) {
    ep.ewmaMs = ep.ewmaMs === null ? ms : ep.ewmaMs + this.alpha * (ms - ep.ewmaMs);
  }

  whyExhausted(method) {
    const now = this.now();
    const out = this.endpoints.filter((ep) => now < ep.bannedUntil);
    if (out.length === this.endpoints.length) {
      const soonest = out.reduce((a, b) => (a.bannedUntil < b.bannedUntil ? a : b));
      return `every endpoint is banned; soonest back: ${soonest.name} in ${Math.ceil((soonest.bannedUntil - now) / 1000)}s`;
    }
    if (this.endpoints.every((ep) => now < ep.bannedUntil || ep.unsupported.has(method))) {
      return `no endpoint supports ${method}`;
    }
    return `every endpoint failed ${method}`;
  }

  /**
   * One cheap eth_blockNumber per endpoint. Run it on a timer, away from real traffic.
   *  - an endpoint banned for quota or its key comes back the moment it answers again
   *  - an endpoint more than maxLagBlocks behind the best head is benched until the next check
   */
  async checkHealth({ maxLagBlocks = 5 } = {}) {
    await Promise.all(this.endpoints.map(async (ep) => {
      try {
        const started = performance.now();
        ep.head = Number(await this.send(ep, 'eth_blockNumber', []));
        this.noteLatency(ep, performance.now() - started);
        if (ep.banReason === 'quota' || ep.banReason === 'key' || ep.banReason === 'behind') {
          ep.bannedUntil = 0;
          ep.banReason = '';
        }
      } catch {
        ep.head = null;
      }
    }));
    const heads = this.endpoints.map((ep) => ep.head).filter(Number.isFinite);
    const best = Math.max(...heads);
    for (const ep of this.endpoints) {
      if (Number.isFinite(ep.head) && best - ep.head > maxLagBlocks && this.now() >= ep.bannedUntil) {
        this.ban(ep, 24 * 60 * 60_000, 'behind');   // lifted by the next check that finds it caught up
      }
    }
  }

  stats() {
    const now = this.now();
    return this.endpoints.map((ep) => ({
      name: ep.name,
      tier: ep.tier,
      ms: ep.ewmaMs === null ? null : Math.round(ep.ewmaMs),
      served: ep.served,
      failed: ep.failed,
      out: now < ep.bannedUntil ? `${ep.banReason} ${Math.ceil((ep.bannedUntil - now) / 1000)}s` : '',
    }));
  }
}

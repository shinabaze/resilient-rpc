// Hands out nonces for one account, so concurrent sends never reuse a nonce or leave a gap.
//
// The flow for every transaction: lease() a nonce, sign and send, then sent(n) if a node
// accepted it or release(n) if it never left. Call sync() with the account's pending
// transaction count now and then, and after any "nonce too low".

export class NonceManager {
  constructor({ rewindAfterMs = 60_000, now = Date.now } = {}) {
    this.next = null;          // the next new nonce; null until the first sync
    this.free = [];            // released and never sent, lowest first
    this.leased = new Set();
    this.highestSent = -1;
    this.stuckSince = null;
    this.rewindAfterMs = rewindAfterMs;
    this.now = now;
  }

  sync(chainCount) {
    if (!Number.isInteger(chainCount) || chainCount < 0) throw new Error(`bad transaction count: ${chainCount}`);
    this.free = this.free.filter((n) => n >= chainCount);
    for (const n of this.leased) if (n < chainCount) this.leased.delete(n);

    let floor = Math.max(chainCount, this.highestSent + 1);
    if (chainCount <= this.highestSent && this.leased.size === 0) {
      // The chain hasn't seen what we sent. Usually it is still on its way, so wait. If it
      // stays that way, the transaction was dropped and its nonce must be used again.
      this.stuckSince ??= this.now();
      if (this.now() - this.stuckSince >= this.rewindAfterMs) {
        this.highestSent = chainCount - 1;
        floor = chainCount;
        this.stuckSince = null;
      }
    } else {
      this.stuckSince = null;
    }
    if (this.next === null || this.next < floor) this.next = floor;
    else if (this.leased.size === 0 && this.free.length === 0) this.next = floor;   // close a gap
    return this.next;
  }

  lease() {
    if (this.next === null) throw new Error('call sync() with the pending transaction count first');
    // Lowest released nonce first: a gap blocks every transaction after it.
    const n = this.free.length ? this.free.shift() : this.next++;
    this.leased.add(n);
    return n;
  }

  sent(n) {
    this.leased.delete(n);
    this.highestSent = Math.max(this.highestSent, n);
    this.stuckSince = null;
  }

  release(n) {
    if (!this.leased.delete(n)) return false;
    this.free.push(n);
    this.free.sort((a, b) => a - b);
    return true;
  }
}

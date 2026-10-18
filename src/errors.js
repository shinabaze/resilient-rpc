// What a failed call says about the endpoint that failed it.
//
// The kind decides everything that follows: try another endpoint or not, and how long to stop
// asking this one. Getting it wrong in either direction hurts. Ban too little and a dead
// endpoint keeps eating time on every call. Ban too much and a healthy pool runs out of endpoints.

export class RpcError extends Error {
  constructor(message, { status, code, data, endpoint } = {}) {
    super(message);
    this.name = 'RpcError';
    this.status = status;   // HTTP status, when there was one
    this.code = code;       // JSON-RPC error code, when there was one
    this.data = data;
    this.endpoint = endpoint;
  }
}

export class PoolExhausted extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'PoolExhausted';
    this.errors = errors;   // [{ endpoint, kind, message }] for every failure on this call
  }
}

// How long each kind keeps an endpoint out of rotation. 0 = try the next one, but no ban.
export const BAN_MS = {
  rate_limit: 60_000,          // per-second or per-minute limit: it is back soon
  quota: 6 * 60 * 60_000,      // the plan's allowance is spent; the revival probe checks sooner
  key: 6 * 60 * 60_000,        // a disabled or wrong key stays dead until a person fixes it
  down: 30_000,                // 5xx or connection refused
  timeout: 0,                  // one stall is noise; a streak of them is a ban (see pool.js)
  elsewhere: 0,                // this node can't do it, another one can
  unknown: 0,
};

export function classify(err) {
  const text = String(err?.message ?? '').toLowerCase();
  const { status, code } = err ?? {};

  // The chain answered. A revert or a nonce error is the same on every node, so moving on
  // would only send the same failing call to every endpoint we have.
  if (code === 3 || /execution reverted|revert|insufficient funds|nonce too low|already known/.test(text)) {
    return 'answer';
  }
  // A filter lives on the node that created it. Another node has never heard of it.
  if (/filter not found/.test(text)) return 'elsewhere';
  if (code === -32601 || /method not (found|supported|available)|not supported/.test(text)) return 'unsupported';
  if (status === 401 || status === 403 || /api key|unauthori[sz]ed|key is disabled/.test(text)) return 'key';
  // Checked before rate limits: a spent monthly quota often comes back as a plain 429.
  if (/monthly|quota|capacity limit|plan limit/.test(text) && !/per second|per minute/.test(text)) return 'quota';
  if (status === 429 || code === -32005 || /rate limit|too many requests/.test(text)) return 'rate_limit';
  if (err?.name === 'TimeoutError' || /timeout|timed out/.test(text)) return 'timeout';
  if (status >= 500 || /econnrefused|econnreset|fetch failed|socket hang up|network/.test(text)) return 'down';
  if (/empty eth_call result/.test(text)) return 'elsewhere';
  return 'unknown';
}

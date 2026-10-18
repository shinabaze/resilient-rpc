import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classify } from '../src/index.js';

const cases = [
  [{ status: 429, message: 'Too Many Requests' }, 'rate_limit'],
  [{ status: 429, message: 'Monthly capacity limit exceeded' }, 'quota'],
  [{ code: -32005, message: 'limit exceeded' }, 'rate_limit'],
  [{ status: 429, message: 'rate limit: 25 requests per second' }, 'rate_limit'],
  [{ code: 3, message: 'execution reverted' }, 'answer'],
  [{ code: -32000, message: 'nonce too low' }, 'answer'],
  [{ code: -32000, message: 'filter not found' }, 'elsewhere'],
  [{ code: -32601, message: 'the method debug_traceCall does not exist' }, 'unsupported'],
  [{ status: 401, message: 'Unauthorized' }, 'key'],
  [{ code: -32051, message: 'API key disabled' }, 'key'],
  [{ name: 'TimeoutError', message: 'timeout' }, 'timeout'],
  [{ status: 503, message: 'Service Unavailable' }, 'down'],
  [{ message: 'ECONNREFUSED' }, 'down'],
  [{ message: 'something new' }, 'unknown'],
];

for (const [err, kind] of cases) {
  test(`${JSON.stringify(err)} is ${kind}`, () => assert.equal(classify(err), kind));
}

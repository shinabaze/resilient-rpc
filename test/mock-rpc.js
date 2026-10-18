import http from 'node:http';

// A local JSON-RPC endpoint you can make misbehave. Change `state.mode` between calls.
// Modes: ok, rate_limit, quota, bad_key, down, hang, revert, empty.
export async function mockRpc({ mode = 'ok', delayMs = 0, head = 100, unsupported = [] } = {}) {
  const state = { mode, delayMs, head, unsupported, calls: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      state.calls++;
      const { id, method } = JSON.parse(raw || '{}');
      if (state.mode === 'hang') return;   // never answers
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
      };
      const fail = (status, code, message) => send(status, { error: { code, message } });

      if (state.unsupported.includes(method)) return fail(200, -32601, `the method ${method} does not exist`);
      switch (state.mode) {
        case 'rate_limit': return fail(429, 429, 'Too Many Requests');
        case 'quota': return fail(429, 429, 'Monthly capacity limit exceeded');
        case 'bad_key': return fail(401, -32000, 'Invalid API key');
        case 'down': return fail(503, -32603, 'Service Unavailable');
        case 'revert': return send(200, { error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } });
        case 'empty': if (method === 'eth_call') return send(200, { result: '0x' }); break;
      }
      if (method === 'eth_blockNumber') return send(200, { result: '0x' + state.head.toString(16) });
      return send(200, { result: '0x2a' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

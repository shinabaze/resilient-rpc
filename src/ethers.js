// Use the pool as an ethers v6 provider: every request ethers makes goes through pool.call().
//   import { PoolProvider } from 'resilient-rpc/ethers'   (needs: npm install ethers@6)
import { JsonRpcProvider, Network } from 'ethers';

export class PoolProvider extends JsonRpcProvider {
  constructor(pool, chainId) {
    // The URL is never fetched: _send below replaces the transport.
    super('http://pool.invalid', Network.from(chainId), { staticNetwork: true, batchMaxCount: 1 });
    this.pool = pool;
  }

  async _send(payload) {
    const requests = Array.isArray(payload) ? payload : [payload];
    return Promise.all(requests.map(async ({ id, method, params }) => {
      try {
        return { id, result: await this.pool.call(method, params) };
      } catch (err) {
        return { id, error: { code: err.code ?? -32603, message: err.message, data: err.data } };
      }
    }));
  }
}

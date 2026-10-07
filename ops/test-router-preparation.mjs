// Mainnet, read-only quote and full packet simulation for buy AND sell on each
// controlled mint. Uses only a public wallet address; never signs or sends.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { executableRoutes } from '../backend/src/hooked-router.js';
import { MARKETS, WSOL, CONTROLLER } from '../backend/src/router-markets.js';
const config = await readFile(new URL('./secrets/mainnet-cli-config.yml', import.meta.url), 'utf8');
const rpc = process.env.RPC_URL || config.match(/json_rpc_url:\s*["']?([^\s"']+)/)?.[1];
const connection = new Connection(rpc, 'confirmed');
if (!(await connection.getGenesisHash()).startsWith('5eykt4')) throw new Error('Mainnet only');
const wallet = new PublicKey(CONTROLLER);
for (const market of MARKETS) {
  for (const side of ['buy', 'sell']) {
    const input = side === 'buy' ? WSOL : market.mint;
    const output = side === 'buy' ? market.mint : WSOL;
    const amount = side === 'buy' ? '100000' : market.id === 'five' ? '100000' : '100000000';
    const result = await executableRoutes(connection, input, output, amount, wallet);
    assert(result.prepared?.simulation !== false);
    assert(result.quote.simulation.passed);
    console.log(JSON.stringify({ market: market.label, side, amount,
      out: result.quote.outAmount, minimum: result.quote.otherAmountThreshold,
      stage: result.prepared.stage, bytes: result.prepared.transactionBytes,
      computeUnits: result.prepared.computeUnits,
      route: result.quote.routePlan.map((step) => step.swapInfo.label), amountMode: result.quote.amountMode }));
  }
}
try {
  await executableRoutes(connection, WSOL, MARKETS[0].mint, '100000', Keypair.generate().publicKey);
  throw new Error('A fresh wallet was accepted');
} catch (error) {
  assert.equal(error.code, 'EXISTING_HOLDER_REQUIRED');
  console.log(JSON.stringify({ nonholderRejected: true, code: error.code }));
}

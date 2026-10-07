// Real mainnet preparation through the HTTP app. Read-only by default; no
// transaction is submitted. The zero-signature auction test verifies the
// authority cannot be induced to sign for an unsigned buyer.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Connection, Keypair } from '@solana/web3.js';
import { createHookMarketApp } from '../backend/src/hook-market-server.js';
import { CONTROLLER, HOOK, MARKETS, WSOL } from '../backend/src/router-markets.js';
const config = await readFile(new URL('./secrets/mainnet-cli-config.yml', import.meta.url), 'utf8');
const rpc = process.env.RPC_URL || config.match(/json_rpc_url:\s*["']?([^\s"']+)/)?.[1];
process.env.TRADER_PREPARE_SECRET = randomBytes(32).toString('hex');
// A matching key is never loaded or needed in preparation. Submit must reject
// before attempting to read/parse this placeholder co-signer secret.
process.env.AUCTION_AUTHORITY_SECRET = 'not-loaded-without-buyer-signature';
const app = createHookMarketApp(new Connection(rpc, 'confirmed'));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const json = async (path, body) => {
  const response = await fetch(`${base}${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: response.status, body: await response.json() };
};
try {
  const markets = await json('/api/trader/markets');
  assert.equal(markets.status, 200); assert.equal(markets.body.markets.length, 3);
  assert(markets.body.markets.every((market) => market.auction.ready));
  console.log(JSON.stringify({ liveAuctions: markets.body.markets.map((market) => ({ mint: market.label, round: market.auction.round })) }));
  const rejected = await json(`/api/trader/order?inputMint=${WSOL}&outputMint=${MARKETS[0].mint}&amount=100000&taker=${Keypair.generate().publicKey}`);
  assert.equal(rejected.status, 403); assert.equal(rejected.body.code, 'EXISTING_HOLDER_REQUIRED');
  console.log(JSON.stringify({ nonholderHttpError: rejected.body.error }));
  for (const market of MARKETS) {
    const quoted = await json(`/api/trader/order?inputMint=${WSOL}&outputMint=${market.mint}&amount=100000&taker=${CONTROLLER}`);
    assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
    assert(quoted.body.simulation.passed && quoted.body.prepared.preparationToken);
    const unsigned = await json('/api/trader/submit', { signedTransaction: quoted.body.prepared.transaction,
      preparationToken: quoted.body.prepared.preparationToken });
    assert.equal(unsigned.body.code, 'BUYER_SIGNATURE_REQUIRED');
    console.log(JSON.stringify({ mint: market.label, simulated: true, bytes: quoted.body.prepared.transactionBytes,
      unsignedTradeRejected: true }));
  }
  const prepared = await json('/api/trader/auction/prepare', { mint: MARKETS[0].mint, buyer: CONTROLLER, programId: HOOK });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const unsigned = await json('/api/trader/auction/submit', { signedTransaction: prepared.body.transaction,
    preparationToken: prepared.body.preparationToken });
  assert.equal(unsigned.status, 400); assert.equal(unsigned.body.code, 'BUYER_SIGNATURE_REQUIRED');
  console.log(JSON.stringify({ auctionPreparedAndSimulated: true, bytes: prepared.body.transactionBytes,
    controllerCannotBeTrickedIntoUnsignedSelfBid: true }));
  const normal = await json(`/api/trader/order?inputMint=${WSOL}&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000`);
  assert.equal(normal.status, 200, JSON.stringify(normal.body));
  assert.equal(normal.body.routeKind, 'jupiter-ultra');
  console.log(JSON.stringify({ ordinaryRoute: 'Jupiter Ultra', outAmount: normal.body.outAmount }));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

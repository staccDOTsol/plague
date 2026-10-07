// Operator self-test of the live English auction API: prepare a bid as the
// 331n wallet, verify its terms, and (with --execute) sign, relay, and confirm
// it. The bid is escrowed on-chain and refunded if anyone outbids it; if it
// wins, payment goes from 331n to 331n (net zero) at settlement.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { MARKETS, CONTROLLER, HOOK } from '../backend/src/router-markets.js';
const origin = process.env.TRADER_ORIGIN || 'https://api.captainhook.fun';
const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(`${homedir()}/hooked.json`, 'utf8'))));
assert.equal(signer.publicKey.toBase58(), CONTROLLER);
const { auctions } = await (await fetch(`${origin}/api/trader/auctions`)).json();
for (const market of MARKETS) {
  const auction = auctions.find((entry) => entry.mint === market.mint);
  assert(auction?.ready, `${market.label} auction not readable`);
  if (auction.phase === 'ended') { console.log(JSON.stringify({ mint: market.label, phase: 'ended', awaitingSettlement: true })); continue; }
  const response = await fetch(`${origin}/api/trader/auction/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mint: market.mint, buyer: CONTROLLER, programId: HOOK, round: auction.round, bidLamports: auction.minNextBidLamports }) });
  const prepared = await response.json(); assert.equal(response.status, 200, JSON.stringify(prepared));
  assert.equal(prepared.paymentRecipient, CONTROLLER); assert.equal(prepared.programId, HOOK); assert.equal(prepared.mint, market.mint);
  assert.equal(prepared.bidLamports, auction.minNextBidLamports);
  console.log(JSON.stringify({ mint: market.label, round: prepared.round, phase: auction.phase, bidLamports: prepared.bidLamports, leader: auction.highBidder, simulated: true }));
  if (!process.argv.includes('--execute')) continue;
  const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, 'base64')); tx.sign([signer]);
  const submitted = await fetch(`${origin}/api/trader/auction/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString('base64'), preparationToken: prepared.preparationToken }) });
  const result = await submitted.json(); assert.equal(submitted.status, 200, JSON.stringify(result));
  let confirmed = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const status = await (await fetch(`${origin}/api/trader/status/${result.signature}`)).json();
    assert.equal(status.err, null);
    if (status.confirmed) { confirmed = true; break; }
  }
  assert(confirmed, 'bid not confirmed');
  console.log(JSON.stringify({ mint: market.label, bidConfirmed: true, signature: result.signature, solscan: `https://solscan.io/tx/${result.signature}` }));
}

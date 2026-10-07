// Restore the operator's own native ATA for verification. This sends account
// setup only; it never wraps SOL or sends a swap.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(`${homedir()}/hooked.json`, 'utf8'))));
const origin = 'https://api.captainhook.fun';
const response = await fetch(`${origin}/api/trader/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo', amount: '100000', taker: signer.publicKey.toBase58(), swapMode: 'ExactIn' }) });
const prepared = await response.json(); assert.equal(response.status, 200, JSON.stringify(prepared));
if (prepared.stage !== 'setup') { console.log('Operator token accounts are already ready.'); process.exit(0); }
const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, 'base64'));
for (const ix of tx.message.compiledInstructions) {
  const program = tx.message.staticAccountKeys[ix.programIdIndex].toBase58();
  assert(['ComputeBudget111111111111111111111111111111', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'].includes(program));
}
tx.sign([signer]);
const submitted = await fetch(`${origin}/api/trader/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString('base64'), preparationToken: prepared.preparationToken }) });
const result = await submitted.json(); assert.equal(submitted.status, 200, JSON.stringify(result));
console.log(JSON.stringify({ setupSubmitted: true, signature: result.signature, swapsSent: 0 }));
for (let i = 0; i < 40; i++) {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const status = await (await fetch(`${origin}/api/trader/status/${result.signature}`)).json();
  assert.equal(status.err, null);
  if (status.confirmed) { console.log(JSON.stringify({ setupConfirmed: true, signature: result.signature })); process.exit(0); }
}
throw new Error(`Setup confirmation pending: ${result.signature}`);

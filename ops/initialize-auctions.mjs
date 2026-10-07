// English auction terms: 0.01 SOL opening bid, 10% minimum raise, 30-minute
// clock from the first bid, 5-minute anti-snipe extension, payment to 331n.
// Existing Dutch-auction accounts (HKAUCT01) are migrated in place and keep
// their round counters. --execute sends; otherwise this only simulates.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { MARKETS, HOOK, CONTROLLER } from '../backend/src/router-markets.js';
export const TERMS = { minBidLamports: 10_000_000n, incrementBps: 1000n, durationSeconds: 1800n, extensionSeconds: 300n };
const program = new PublicKey(HOOK), admin = new PublicKey(CONTROLLER);
const config = await readFile(new URL('./secrets/mainnet-cli-config.yml', import.meta.url), 'utf8');
const rpc = process.env.RPC_URL || config.match(/json_rpc_url:\s*["']?([^\s"']+)/)?.[1];
const connection = new Connection(rpc, 'confirmed');
if (!(await connection.getGenesisHash()).startsWith('5eykt4')) throw new Error('Mainnet only');
const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(`${homedir()}/hooked.json`, 'utf8'))));
assert(signer.publicKey.equals(admin));
const pda = (seed, mint) => PublicKey.findProgramAddressSync([Buffer.from(seed), mint.toBuffer()], program)[0];
const u64 = (value) => { const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt(value)); return data; };
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const addresses = MARKETS.map((market) => pda('auction', new PublicKey(market.mint)));
const existing = await connection.getMultipleAccountsInfo(addresses, 'confirmed');
const instructions = [];
for (let i = 0; i < MARKETS.length; i++) {
  const mint = new PublicKey(MARKETS[i].mint), info = existing[i];
  if (info?.owner.equals(program) && info.data.subarray(0, 8).toString() === 'HKAUCT02') {
    assert.equal(info.data.readBigUInt64LE(104), TERMS.minBidLamports); assert.equal(info.data.readBigUInt64LE(112), TERMS.incrementBps);
    assert.equal(info.data.readBigUInt64LE(120), TERMS.durationSeconds); assert.equal(info.data.readBigUInt64LE(128), TERMS.extensionSeconds);
    continue;
  }
  if (info?.owner.equals(program)) assert.equal(info.data.subarray(0, 8).toString(), 'HKAUCT01', 'unknown auction layout');
  instructions.push({ programId: program, data: Buffer.concat([Buffer.from([6]), u64(TERMS.minBidLamports), u64(TERMS.incrementBps), u64(TERMS.durationSeconds), u64(TERMS.extensionSeconds), admin.toBuffer()]),
    keys: [meta(admin, true, true), meta(mint), meta(pda('config', mint)), meta(addresses[i], true), meta(SystemProgram.programId)] });
}
if (instructions.length) {
  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: admin, recentBlockhash: latest.blockhash, instructions }).compileToV0Message());
  assert(tx.serialize().length <= 1232); tx.sign([signer]);
  const simulation = await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
  assert.equal(simulation.value.err, null, simulation.value.logs?.join('\n'));
  console.log(JSON.stringify({ simulated: true, auctions: instructions.length, terms: '0.01 SOL opening, +10% raises, 30 min from first bid, 5 min anti-snipe' }));
  if (!process.argv.includes('--execute')) process.exit(0);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
  assert.equal((await connection.confirmTransaction({ signature, ...latest }, 'confirmed')).value.err, null);
  console.log(JSON.stringify({ initialized: true, signature, solscan: `https://solscan.io/tx/${signature}` }));
}
const ready = await connection.getMultipleAccountsInfo(addresses, 'confirmed');
ready.forEach((info, i) => {
  assert.equal(info.data.subarray(0, 8).toString(), 'HKAUCT02');
  console.log(JSON.stringify({ mint: MARKETS[i].label, auction: addresses[i].toBase58(), round: info.data.readBigUInt64LE(136).toString(),
    endsAt: info.data.readBigInt64LE(152).toString(), highBidLamports: info.data.readBigUInt64LE(192).toString(),
    minBidLamports: info.data.readBigUInt64LE(104).toString(), incrementBps: info.data.readBigUInt64LE(112).toString(),
    durationSeconds: info.data.readBigUInt64LE(120).toString(), extensionSeconds: info.data.readBigUInt64LE(128).toString() }));
});

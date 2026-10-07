// Verify deployed bytes, migrate holder-proof EAMLs, and simulate positive and
// rejected checked transfers. --execute sends ONLY the EAML migration.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedWithTransferHookInstruction, getAccount,
  getAssociatedTokenAddressSync, getExtraAccountMetas, getMint,
} from '@solana/spl-token';

const HOOK = new PublicKey('VwcGiFProGtfYLKsDpJuxZoYMFZpuZ1XT6MGmBd9AwU');
const ADMIN = new PublicKey('331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth');
const RECIPIENT = new PublicKey('99VXriv7RXJSypeJDBQtGRsak1n5o2NBzbtMXhHW2RNG');
const MINTS = [
  'XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo',
  '5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd',
  'DZVfZHdtS266p4qpTR7vFXxXbrBku18nt9Uxp4KD9bsi',
].map((mint) => new PublicKey(mint));
const config = await readFile(new URL('./secrets/mainnet-cli-config.yml', import.meta.url), 'utf8');
const rpc = process.env.RPC_URL || config.match(/json_rpc_url:\s*["']?([^\s"']+)/)?.[1];
const connection = new Connection(rpc, 'confirmed');
if (!(await connection.getGenesisHash()).startsWith('5eykt4')) throw new Error('Mainnet only');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(`${homedir()}/hooked.json`, 'utf8'))));
assert(payer.publicKey.equals(ADMIN));
const pda = (seed, mint) => PublicKey.findProgramAddressSync([Buffer.from(seed), mint.toBuffer()], HOOK)[0];
const programInfo = await connection.getAccountInfo(HOOK, 'confirmed');
assert(programInfo?.executable && programInfo.data.readUInt32LE(0) === 2);
const programData = new PublicKey(programInfo.data.subarray(4, 36));
const deployed = await connection.getAccountInfo(programData, 'confirmed');
assert(deployed.data[12] === 1 && new PublicKey(deployed.data.subarray(13, 45)).equals(ADMIN));
const local = await readFile(new URL('../program/target/deploy/thoook.so', import.meta.url));
const hash = (data) => createHash('sha256').update(data).digest('hex');
assert.equal(hash(deployed.data.subarray(45, 45 + local.length)), hash(local), 'Deployed code must match the tested SBF');
assert(deployed.data.subarray(45 + local.length).every((byte) => byte === 0));
console.log(JSON.stringify({ deployedBytesVerified: true, sha256: hash(local),
  program: HOOK.toBase58(), deploySlot: deployed.data.readBigUInt64LE(4).toString(), authority: ADMIN.toBase58() }));

async function transaction(instructions) {
  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: ADMIN,
    recentBlockhash: latest.blockhash, instructions }).compileToV0Message());
  assert(tx.serialize().length <= 1232, 'Packet size limit'); tx.sign([payer]);
  return { tx, latest };
}
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const eamlAddresses = MINTS.map((mint) => pda('extra-account-metas', mint));
const eamlInfos = await connection.getMultipleAccountsInfo(eamlAddresses, 'confirmed');
const migrations = MINTS.flatMap((mint, i) => {
  assert(eamlInfos[i]?.owner.equals(HOOK));
  if (getExtraAccountMetas(eamlInfos[i]).length === 3) return [];
  return [{ programId: HOOK, data: Buffer.from([5]), keys: [meta(ADMIN, true, true),
    meta(mint), meta(pda('config', mint)), meta(eamlAddresses[i], true), meta(SystemProgram.programId)] }];
});
if (migrations.length) {
  const { tx, latest } = await transaction([ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }), ...migrations]);
  const simulated = await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
  assert.equal(simulated.value.err, null, simulated.value.logs?.join('\n'));
  console.log(JSON.stringify({ eamlMigrationSimulated: true, mints: migrations.length }));
  if (!process.argv.includes('--execute')) {
    console.log('Run with --execute to update the three EAMLs. No token transfer will be broadcast.');
    process.exit(0);
  }
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
  const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  assert.equal(result.value.err, null);
  console.log(JSON.stringify({ eamlMigrationConfirmed: true, signature, solscan: `https://solscan.io/tx/${signature}` }));
}
const ready = await connection.getMultipleAccountsInfo(eamlAddresses, 'confirmed');
for (const info of ready) assert.equal(getExtraAccountMetas(info).length, 3);

for (const mint of MINTS) {
  const decoded = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const source = getAssociatedTokenAddressSync(mint, ADMIN, false, TOKEN_2022_PROGRAM_ID);
  const destination = getAssociatedTokenAddressSync(mint, RECIPIENT, false, TOKEN_2022_PROGRAM_ID);
  const [from, to] = await Promise.all([getAccount(connection, source, 'confirmed', TOKEN_2022_PROGRAM_ID),
    getAccount(connection, destination, 'confirmed', TOKEN_2022_PROGRAM_ID)]);
  assert(from.amount > 1n && to.amount > 0n);
  const positiveIx = await createTransferCheckedWithTransferHookInstruction(connection, source, mint,
    destination, ADMIN, 1n, decoded.decimals, [], 'confirmed', TOKEN_2022_PROGRAM_ID);
  const positive = await transaction([positiveIx]);
  const allowed = await connection.simulateTransaction(positive.tx, { sigVerify: true, commitment: 'confirmed' });
  assert.equal(allowed.value.err, null, allowed.value.logs?.join('\n'));
  assert(allowed.value.logs.some((line) => line.includes(`Program ${HOOK} success`)));

  const freshOwner = Keypair.generate().publicKey;
  const freshAta = getAssociatedTokenAddressSync(mint, freshOwner, false, TOKEN_2022_PROGRAM_ID);
  // The account is created by the same simulated transaction. Supply its planned
  // owner/mint bytes only to the off-chain EAML resolver; the real RPC simulation
  // independently creates and validates it via the Associated Token Program.
  const planned = Buffer.alloc(165); mint.toBuffer().copy(planned); freshOwner.toBuffer().copy(planned, 32);
  const resolver = { getAccountInfo: async (address, commitment) => address.equals(freshAta)
    ? { owner: TOKEN_2022_PROGRAM_ID, data: planned, lamports: 0, executable: false, rentEpoch: 0 }
    : connection.getAccountInfo(address, commitment) };
  const rejectedIx = await createTransferCheckedWithTransferHookInstruction(resolver, source, mint,
    freshAta, ADMIN, 1n, decoded.decimals, [], 'confirmed', TOKEN_2022_PROGRAM_ID);
  const negative = await transaction([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }),
    createAssociatedTokenAccountIdempotentInstruction(ADMIN, freshAta, freshOwner, mint, TOKEN_2022_PROGRAM_ID),
    rejectedIx,
  ]);
  const rejected = await connection.simulateTransaction(negative.tx, { sigVerify: true, commitment: 'confirmed' });
  assert(rejected.value.err, 'A first transfer must be rejected on mainnet');
  assert(rejected.value.logs.some((line) => line.includes('existing holders only')), rejected.value.logs?.join('\n'));
  assert(rejected.value.logs.some((line) => line.includes('custom program error: 0xd')));
  console.log(JSON.stringify({ mint: mint.toBase58(), mainnetExistingHolderSimulation: 'passed',
    mainnetZeroHolderSimulation: 'rejected with 13', eamlMetas: 3, tokenTransfersBroadcast: 0 }));
}

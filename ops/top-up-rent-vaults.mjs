// One-time 0.3 SOL THOOOK infection-status reserve top-up, authorized
// 2026-10-06. Simulates first; --execute broadcasts on Solana mainnet.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  Connection, Keypair, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';

const PROGRAM = new PublicKey('VwcGiFProGtfYLKsDpJuxZoYMFZpuZ1XT6MGmBd9AwU');
const OWNER = new PublicKey('331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth');
const STATUS_RENT = 1_325_880n; // 133 bytes at mainnet rent exemption (rechecked below).
const PLAN = [
  { name: 'XEEu', mint: 'XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo', before: 17_348_240n, add: 200_000_000n },
  { name: '5oCp', mint: '5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd', before: 1_674_120n, add: 50_000_000n },
  { name: 'DZVf', mint: 'DZVfZHdtS266p4qpTR7vFXxXbrBku18nt9Uxp4KD9bsi', before: 1_674_120n, add: 50_000_000n },
];
const EXECUTE = process.argv.includes('--execute');
const pathOf = (path) => path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const pda = (seed, mint) => PublicKey.findProgramAddressSync([Buffer.from(seed), mint.toBuffer()], PROGRAM)[0];
const le64 = (n) => { const data = Buffer.alloc(8); data.writeBigUInt64LE(n); return data; };
const configRaw = await readFile(pathOf('ops/secrets/mainnet-cli-config.yml'), 'utf8');
const rpc = process.env.RPC_URL || configRaw.match(/json_rpc_url:\s*["']?([^\s"']+)/)?.[1];
if (!rpc) throw new Error('Missing mainnet RPC');
const connection = new Connection(rpc, 'confirmed');
if (!(await connection.getGenesisHash()).startsWith('5eykt4')) throw new Error('Not Solana mainnet');
const keyBytes = JSON.parse(await readFile(pathOf('~/hooked.json'), 'utf8'));
const payer = Keypair.fromSecretKey(Uint8Array.from(keyBytes));
if (!payer.publicKey.equals(OWNER)) throw new Error('331n key mismatch');
if (BigInt(await connection.getMinimumBalanceForRentExemption(133, 'confirmed')) !== STATUS_RENT) {
  throw new Error('Status rent changed; review amount and capacity before funding');
}
const addresses = PLAN.flatMap((item) => {
  item.mintKey = new PublicKey(item.mint);
  item.config = pda('config', item.mintKey);
  item.vault = pda('rent-vault', item.mintKey);
  return [item.config, item.vault];
});
const accounts = await connection.getMultipleAccountsInfo(addresses, 'confirmed');
const instructions = [];
for (let i = 0; i < PLAN.length; i++) {
  const item = PLAN[i];
  const [config, vault] = accounts.slice(i * 2, i * 2 + 2);
  if (!config?.owner.equals(PROGRAM) || config.data.subarray(0, 8).toString() !== 'THOOKCFG' ||
      !vault?.owner.equals(SystemProgram.programId) || BigInt(vault.lamports) !== item.before) {
    throw new Error(`${item.name}: config/vault mismatch or reserve changed; recheck plan`);
  }
  instructions.push({ programId: PROGRAM,
    keys: [meta(OWNER, true, true), meta(item.mintKey), meta(item.config),
      meta(item.vault, true), meta(SystemProgram.programId)],
    data: Buffer.concat([Buffer.from([2]), le64(item.add)]),
  });
  console.log(JSON.stringify({ mint: item.name, vault: item.vault.toBase58(),
    beforeLamports: item.before.toString(), addLamports: item.add.toString(),
    afterLamports: (item.before + item.add).toString(),
    affordableNewStatuses: ((item.before + item.add) / STATUS_RENT).toString() }));
}
const total = PLAN.reduce((sum, item) => sum + item.add, 0n);
if (total !== 300_000_000n) throw new Error('Funding exceeds authorized 0.3 SOL');
if (BigInt(await connection.getBalance(OWNER, 'confirmed')) < total + 50_000_000n) {
  throw new Error('Insufficient owner balance for reserve plus fee buffer');
}
const latest = await connection.getLatestBlockhash('confirmed');
const transaction = new VersionedTransaction(new TransactionMessage({
  payerKey: OWNER, recentBlockhash: latest.blockhash, instructions,
}).compileToV0Message());
if (transaction.serialize().length > 1232) throw new Error('Funding transaction exceeds size limit');
transaction.sign([payer]);
const simulation = await connection.simulateTransaction(transaction, { sigVerify: true, commitment: 'confirmed' });
if (simulation.value.err) throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}; ${simulation.value.logs?.slice(-10).join(' | ')}`);
console.log(JSON.stringify({ simulated: true, totalLamports: total.toString(),
  computeUnits: simulation.value.unitsConsumed, execute: EXECUTE }));
if (!EXECUTE) process.exit(0);
const signature = await connection.sendRawTransaction(transaction.serialize(), {
  skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3,
});
const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
if (confirmation.value.err) throw new Error(`Funding failed: ${JSON.stringify(confirmation.value.err)}; ${signature}`);
const after = await connection.getMultipleAccountsInfo(PLAN.map((item) => item.vault), 'confirmed');
for (let i = 0; i < PLAN.length; i++) {
  if (BigInt(after[i]?.lamports ?? 0) < PLAN[i].before + PLAN[i].add) {
    throw new Error(`Funding confirmed but ${PLAN[i].name} reserve readout is lower than planned; ${signature}`);
  }
}
console.log(JSON.stringify({ confirmed: true, signature, solscan: `https://solscan.io/tx/${signature}` }));

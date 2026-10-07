// Create the two Token-2022 ATAs and one raw XEEu unit needed for a mainnet
// transfer-hook smoke test. Simulates first; --execute is required to send.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  getAssociatedTokenAddressSync, getMint, getAccount,
} from '@solana/spl-token';

const execute = process.argv.includes('--execute');
const payerAddress = new PublicKey('331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth');
const recipientAddress = new PublicKey('99VXriv7RXJSypeJDBQtGRsak1n5o2NBzbtMXhHW2RNG');
const mintAddress = new PublicKey('XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo');
const expand = (path) => path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);
const handoff = process.env.HANDOFF_PATH ? await readFile(expand(process.env.HANDOFF_PATH), 'utf8') : '';
const rpc = process.env.RPC_URL || handoff.match(/https:\/\/mainnet\.helius-rpc\.com\/\?api-key=[^\s)]+/)?.[0];
if (!rpc) throw new Error('RPC_URL or HANDOFF_PATH required');
const connection = new Connection(rpc, 'confirmed');
if (!(await connection.getGenesisHash()).startsWith('5eykt4')) throw new Error('Expected mainnet');
const mint = await getMint(connection, mintAddress, 'confirmed', TOKEN_2022_PROGRAM_ID);
if (!mint.mintAuthority?.equals(payerAddress)) throw new Error('331n is no longer XEEu mint authority');
const source = getAssociatedTokenAddressSync(mintAddress, payerAddress, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
const destination = getAssociatedTokenAddressSync(mintAddress, recipientAddress, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
const existingSource = await getAccount(connection, source, 'confirmed', TOKEN_2022_PROGRAM_ID).catch(() => null);
const ixs = [
  createAssociatedTokenAccountIdempotentInstruction(payerAddress, source, payerAddress, mintAddress, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
  createAssociatedTokenAccountIdempotentInstruction(payerAddress, destination, recipientAddress, mintAddress, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
];
if (!existingSource?.amount) ixs.push(createMintToInstruction(mintAddress, source, payerAddress, 1n, [], TOKEN_2022_PROGRAM_ID));
const latest = await connection.getLatestBlockhash('confirmed');
const message = new TransactionMessage({ payerKey: payerAddress, recentBlockhash: latest.blockhash, instructions: ixs }).compileToV0Message();
const tx = new VersionedTransaction(message);
const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' });
if (sim.value.err) {
  console.error(sim.value.logs?.slice(-20).join('\n'));
  throw new Error(`Preparation simulation failed: ${JSON.stringify(sim.value.err)}`);
}
console.log(JSON.stringify({ execute, source: source.toBase58(), destination: destination.toBase58(), sourceBalanceRaw: existingSource?.amount.toString() ?? '0', mintRaw: existingSource?.amount ? '0' : '1', units: sim.value.unitsConsumed }));
if (execute) {
  const secret = JSON.parse(await readFile(expand(process.env.FEE_PAYER || '~/hooked.json'), 'utf8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  if (!payer.publicKey.equals(payerAddress)) throw new Error('Payer signer mismatch');
  tx.sign([payer]);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  if (result.value.err) throw new Error(`Preparation failed: ${JSON.stringify(result.value.err)}; ${signature}`);
  console.log(`Mainnet smoke accounts prepared: ${signature}`);
}

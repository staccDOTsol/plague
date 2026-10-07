// Read-only mainnet probe: can OKX's proVF4p router forward XEEu hook metas
// merely by appending them to the outer router instruction? Never signs/sends.
import { readFile } from 'node:fs/promises';
import { Wallet } from '@coral-xyz/anchor';
import { TokenExtensionUtil, WhirlpoolContext } from '@orca-so/whirlpools-sdk';
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';

const SIGNATURE = '4nQJS9uqAiecKtq1vXsJSiyLRFR93pxz852DoDEtbewSZ3h5XnvGtfxL2iHyVvgHNA19pNBmNhaHA5yZzhghkawK';
const BUYER = new PublicKey('331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth');
const ROUTER = new PublicKey('proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u');
const ORCA = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const POOL = new PublicKey('9zST8JLNeJXH518mDmAQRiKfYtoG8AymytyoEK8pkdfa');
const XEEU = new PublicKey('XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo');

const yaml = await readFile(new URL('./secrets/mainnet-cli-config.yml', import.meta.url), 'utf8');
const url = yaml.match(/^json_rpc_url:\s*['"]?([^\s'"]+)/m)?.[1];
if (!url) throw new Error('No local RPC config');
const connection = new Connection(url, 'confirmed');
if (!(await connection.getGenesisHash()).startsWith('5eykt4')) throw new Error('Not mainnet');

const original = await connection.getTransaction(SIGNATURE, {
  commitment: 'confirmed', maxSupportedTransactionVersion: 0,
});
if (!original) throw new Error('Original OKX transaction unavailable');
const alts = await Promise.all(original.transaction.message.addressTableLookups.map(async ({ accountKey }) => {
  const response = await connection.getAddressLookupTable(accountKey, { commitment: 'confirmed' });
  if (!response.value) throw new Error(`Missing ALT ${accountKey}`);
  return response.value;
}));
const decompiled = TransactionMessage.decompile(original.transaction.message, {
  addressLookupTableAccounts: alts,
});
const router = decompiled.instructions.find((ix) => ix.programId.equals(ROUTER));
if (!router) throw new Error('Original transaction lacks OKX router');
const ctx = WhirlpoolContext.from(connection, new Wallet(Keypair.generate()), undefined, undefined, {}, ORCA);
const pool = await ctx.fetcher.getPool(POOL);
if (!pool) throw new Error('XEEu pool unavailable');
const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContext(ctx.fetcher, pool);
const buyerWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, BUYER, false, TOKEN_PROGRAM_ID);
const buyerXeeuAta = getAssociatedTokenAddressSync(XEEU, BUYER, false, TOKEN_2022_PROGRAM_ID);
const extra = await TokenExtensionUtil.getExtraAccountMetasForTransferHookForPool(
  connection, tokenExtensionCtx,
  buyerWsolAta, pool.tokenVaultA, BUYER,
  pool.tokenVaultB, buyerXeeuAta, POOL,
);
const metas = extra.tokenTransferHookAccountsB;
if (!metas?.length) throw new Error('Hook EAML metas did not resolve');
const present = new Set(router.keys.map((key) => key.pubkey.toBase58()));
const newlyAdded = metas.filter((meta) => !present.has(meta.pubkey.toBase58()));
router.keys.push(...newlyAdded);
// The historical source USDC ATA now holds only 0.141512 USDC; the original
// route requested 0.199 USDC. Scale the probe to 0.1 USDC and set a trivial
// final minimum so a stale quote does not mask the hook-forwarding behavior.
const originalInputRaw = router.data.readBigUInt64LE(16).toString();
const originalMinimumRaw = router.data.readBigUInt64LE(24).toString();
router.data.writeBigUInt64LE(100_000n, 16);
router.data.writeBigUInt64LE(1n, 24);

const originalBytes = new VersionedTransaction(original.transaction.message).serialize().length;
const setupAccounts = await Promise.all(decompiled.instructions.filter((ix) =>
  ix.programId.toBase58() === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
).map(async (ix) => ({ address: ix.keys[1].pubkey.toBase58(), exists: Boolean(await connection.getAccountInfo(ix.keys[1].pubkey, 'confirmed')) })));
// The original tx includes a post-swap SOL tip. Omitting it is harmless for
// a read-only probe and frees packet space for the hook accounts.
const final = decompiled.instructions.at(-1);
const droppedTip = final?.programId.equals(new PublicKey('11111111111111111111111111111111'));
if (droppedTip) decompiled.instructions.pop();

const blockhash = await connection.getLatestBlockhash('confirmed');
const transaction = new VersionedTransaction(new TransactionMessage({
  payerKey: BUYER, recentBlockhash: blockhash.blockhash, instructions: decompiled.instructions,
}).compileToV0Message(alts));
let bytes;
try { bytes = transaction.serialize().length; }
catch (error) {
  console.log(JSON.stringify({ originalBytes, originalRouterAccounts: router.keys.length - newlyAdded.length,
    hookMetas: metas.map((meta) => meta.pubkey.toBase58()),
    newlyAdded: newlyAdded.map((meta) => meta.pubkey.toBase58()),
    setupAccounts, droppedTip, serializationError: error.message }, null, 2));
  process.exit(0);
}
const result = await connection.simulateTransaction(transaction, {
  sigVerify: false, commitment: 'confirmed', replaceRecentBlockhash: true,
});
const logs = result.value.logs || [];
const finalWhirlpool = logs.lastIndexOf('Program log: 9zST8JLNeJXH518mDmAQRiKfYtoG8AymytyoEK8pkdfa');
console.log(JSON.stringify({
  originalSignature: SIGNATURE,
  originalBytes,
  originalInputRaw,
  originalMinimumRaw,
  probeInputRaw: '100000',
  probeMinimumRaw: '1',
  originalError: original.meta.err,
  originalRouterAccounts: router.keys.length - newlyAdded.length,
  hookMetas: metas.map((meta) => meta.pubkey.toBase58()),
  newlyAdded: newlyAdded.map((meta) => meta.pubkey.toBase58()),
  setupAccounts,
  droppedTip,
  transactionBytes: bytes,
  simulationError: result.value.err,
  finalPoolReached: finalWhirlpool >= 0,
  finalLogs: logs.slice(finalWhirlpool >= 0 ? finalWhirlpool : -22).slice(0, 22),
}, null, 2));

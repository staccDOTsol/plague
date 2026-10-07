// Read-only mainnet proof of the XEEu/WSOL Pinocchio-hook Whirlpool trade.
import { readFile } from 'node:fs/promises';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, getTransferHook, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { Wallet } from '@coral-xyz/anchor';
import { Keypair } from '@solana/web3.js';
import { WhirlpoolContext, buildWhirlpoolClient } from '@orca-so/whirlpools-sdk';

const mint = new PublicKey('XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo');
const pool = new PublicKey('9zST8JLNeJXH518mDmAQRiKfYtoG8AymytyoEK8pkdfa');
const hookProgram = new PublicKey('VwcGiFProGtfYLKsDpJuxZoYMFZpuZ1XT6MGmBd9AwU');
const buyer = new PublicKey('331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth');
const whirlpoolProgram = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const tradeSignature = '4zuRnGDWJg7ccG7FHufRiKAXFZDWzc9G3pd5MNB6CnxTjcxfZp72X8GUBbMYWMUQJ69uvpxEks8yNGz23CSE3ifm';
const handoff = process.env.HANDOFF_PATH ? await readFile(process.env.HANDOFF_PATH, 'utf8') : '';
const rpc = process.env.RPC_URL || handoff.match(/https:\/\/mainnet\.helius-rpc\.com\/\?api-key=[^\s)]+/)?.[0];
if (!rpc) throw new Error('RPC_URL or HANDOFF_PATH required');
const connection = new Connection(rpc, 'confirmed');
if (!(await connection.getGenesisHash()).startsWith('5eykt4')) throw new Error('Expected mainnet');
const [buyerStatus] = PublicKey.findProgramAddressSync([Buffer.from('status'), mint.toBuffer(), buyer.toBuffer()], hookProgram);
const [tx, mintState, hookInfo, statusInfo] = await Promise.all([
  connection.getTransaction(tradeSignature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
  getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID),
  connection.getAccountInfo(hookProgram, 'confirmed'),
  connection.getAccountInfo(buyerStatus, 'confirmed'),
]);
if (!tx || tx.meta?.err) throw new Error(`Trade missing or failed: ${JSON.stringify(tx?.meta?.err)}`);
const pointer = getTransferHook(mintState)?.programId;
const hookAuthority = getTransferHook(mintState)?.authority;
if (!pointer?.equals(hookProgram) || !hookInfo?.executable) throw new Error('Hook pointer or program is not live');
const logs = tx.meta.logMessages ?? [];
const hookInvoked = logs.some((line) => line.includes(`Program ${hookProgram.toBase58()} invoke`));
const whirlpoolInvoked = logs.some((line) => line.includes(`Program ${whirlpoolProgram.toBase58()} invoke`));
if (!hookInvoked || !whirlpoolInvoked) throw new Error('Trade logs do not show both Whirlpool and THOOOK');
if (!statusInfo?.owner.equals(hookProgram) || statusInfo.data.length !== 133 ||
    statusInfo.data.subarray(0, 8).toString() !== 'THOOKSTS') {
  throw new Error('Buyer infection status missing after trade');
}
const ctx = WhirlpoolContext.from(connection, new Wallet(Keypair.generate()), undefined, undefined, {}, whirlpoolProgram);
const whirlpool = await buildWhirlpoolClient(ctx).getPool(pool);
const poolState = whirlpool.getData();
if (poolState.liquidity.isZero()) throw new Error('Pool has no live liquidity');
const keyList = tx.transaction.message.staticAccountKeys.map((key) => key.toBase58());
const parseBalances = (balances) => balances
  .filter((entry) => entry.mint === mint.toBase58() || entry.mint === 'So11111111111111111111111111111111111111112')
  .map((entry) => ({ tokenAccount: keyList[entry.accountIndex], owner: entry.owner, mint: entry.mint, raw: entry.uiTokenAmount.amount }));
console.log(JSON.stringify({
  signature: tradeSignature,
  slot: tx.slot,
  error: tx.meta.err,
  hookProgram: hookProgram.toBase58(),
  hookAuthority: hookAuthority?.toBase58(),
  hookInvoked,
  whirlpoolInvoked,
  pool: pool.toBase58(),
  liquidityRaw: poolState.liquidity.toString(),
  buyerStatus: {
    address: buyerStatus.toBase58(),
    parent: new PublicKey(statusInfo.data.subarray(72, 104)).toBase58(),
    generation: statusInfo.data.readUInt32LE(104),
    infectedAt: statusInfo.data.readBigInt64LE(108).toString(),
    via: statusInfo.data[132],
  },
  preTokenBalances: parseBalances(tx.meta.preTokenBalances ?? []),
  postTokenBalances: parseBalances(tx.meta.postTokenBalances ?? []),
}, null, 2));

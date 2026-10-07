// Builds buyer-signed Orca SwapV2 transactions for the live XEEu/WSOL pool.
// The server holds no wallet key and never signs or broadcasts a transaction.
import { Wallet } from '@coral-xyz/anchor';
import { Percentage } from '@orca-so/common-sdk';
import {
  PDAUtil, PriceMath, TokenExtensionUtil, WhirlpoolContext, WhirlpoolIx,
  buildWhirlpoolClient, swapQuoteByInputToken,
} from '@orca-so/whirlpools-sdk';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction, getAssociatedTokenAddressSync, getMint,
  getTransferHook,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram, Keypair, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { tradeFailure } from './trade-errors.js';

const XEEU = new PublicKey('XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo');
const POOL = new PublicKey('9zST8JLNeJXH518mDmAQRiKfYtoG8AymytyoEK8pkdfa');
const HOOK = new PublicKey('VwcGiFProGtfYLKsDpJuxZoYMFZpuZ1XT6MGmBd9AwU');
const HOOK_AUTHORITY = new PublicKey('331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth');
const PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const MIN_LAMPORTS = 100_000n;
const MAX_LAMPORTS = 300_000_000n;
const SLIPPAGE = Percentage.fromFraction(1, 100);

function parseRequest(body) {
  const amount = body?.amountLamports;
  if (typeof body?.buyer !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.buyer) ||
      typeof amount !== 'string' || !/^[1-9][0-9]{0,8}$/.test(amount)) return null;
  try {
    const buyer = new PublicKey(body.buyer);
    const lamports = BigInt(amount);
    if (!PublicKey.isOnCurve(buyer.toBuffer()) || lamports < MIN_LAMPORTS || lamports > MAX_LAMPORTS) return null;
    return { buyer, lamports };
  } catch { return null; }
}

function instructions(bundle) { return [...bundle.instructions, ...bundle.cleanupInstructions]; }

async function unsignedTransaction(connection, buyer, ixs, label) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: buyer, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message());
  if (transaction.serialize().length > 1232) throw new Error(`${label} transaction exceeds Solana size limit`);
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: false, commitment: 'confirmed', replaceRecentBlockhash: true,
  });
  if (simulation.value.err) throw new Error(`${label} simulation failed: ${JSON.stringify(simulation.value.err)}; ${simulation.value.logs?.slice(-12).join(' | ') || 'no logs'}`);
  return {
    transaction: Buffer.from(transaction.serialize()).toString('base64'),
    blockhash, lastValidBlockHeight,
    computeUnits: simulation.value.unitsConsumed,
  };
}

export async function prepareDirectBuy(connection, body) {
  const parsed = parseRequest(body);
  if (!parsed) return { status: 400, body: { error: 'Enter a valid wallet and 0.0001–0.3 SOL amount.' } };
  const { buyer, lamports } = parsed;
  const genesis = await connection.getGenesisHash();
  if (!genesis.startsWith('5eykt4')) throw new Error('Configured RPC is not Solana mainnet');
  const mint = await getMint(connection, XEEU, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const hook = getTransferHook(mint);
  if (!hook?.programId?.equals(HOOK) || !hook.authority?.equals(HOOK_AUTHORITY)) {
    throw new Error('Live XEEu hook changed; buy preparation is paused');
  }
  const held = await connection.getTokenAccountsByOwner(buyer, { mint: XEEU }, 'confirmed');
  const holdsMint = held.value.some(({ account }) => account.owner.equals(TOKEN_2022_PROGRAM_ID) &&
    account.data.length >= 72 && account.data.subarray(0, 32).equals(XEEU.toBuffer()) &&
    account.data.subarray(32, 64).equals(buyer.toBuffer()) && account.data.readBigUInt64LE(64) > 0n);
  if (!holdsMint) return { status: 403, body: {
    code: 'EXISTING_HOLDER_REQUIRED', mint: XEEU.toBase58(), buyer: buyer.toBase58(),
    error: 'This wallet does not already hold XEEu. The hook requires a positive XEEu balance before a buy or transfer. Connect a wallet that already holds this mint.',
  } };
  const ctx = WhirlpoolContext.from(connection, new Wallet(Keypair.generate()), undefined, undefined, {}, PROGRAM);
  const pool = await ctx.fetcher.getPool(POOL);
  if (!pool || !pool.tokenMintA.equals(NATIVE_MINT) || !pool.tokenMintB.equals(XEEU) || pool.liquidity.isZero()) {
    throw new Error('Live XEEu/WSOL Whirlpool is unavailable');
  }
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, buyer, false, TOKEN_PROGRAM_ID);
  const xeeuAta = getAssociatedTokenAddressSync(XEEU, buyer, false, TOKEN_2022_PROGRAM_ID);
  const [wsolAccount, xeeuAccount] = await connection.getMultipleAccountsInfo([wsolAta, xeeuAta], 'confirmed');
  if ((wsolAccount && !wsolAccount.owner.equals(TOKEN_PROGRAM_ID)) ||
      (xeeuAccount && !xeeuAccount.owner.equals(TOKEN_2022_PROGRAM_ID))) {
    throw new Error('A buyer token account has an unexpected owner');
  }
  if (!wsolAccount || !xeeuAccount) {
    const ixs = [];
    if (!wsolAccount) ixs.push(createAssociatedTokenAccountIdempotentInstruction(
      buyer, wsolAta, buyer, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ));
    if (!xeeuAccount) ixs.push(createAssociatedTokenAccountIdempotentInstruction(
      buyer, xeeuAta, buyer, XEEU, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ));
    const tx = await unsignedTransaction(connection, buyer, ixs, 'Token account setup');
    return { status: 200, body: {
      chain: 'mainnet-beta', stage: 'setup', buyer: buyer.toBase58(),
      pool: POOL.toBase58(), accounts: { wsol: wsolAta.toBase58(), xeeu: xeeuAta.toBase58() },
      message: 'Create the wallet’s WSOL and XEEu token accounts first. This transaction does not swap or wrap SOL; token account rent and network fees apply.',
      ...tx,
    } };
  }
  const whirlpool = await buildWhirlpoolClient(ctx).getPool(POOL);
  const quote = await swapQuoteByInputToken(
    whirlpool, NATIVE_MINT, new BN(lamports.toString()), SLIPPAGE, PROGRAM, ctx.fetcher,
  );
  if (!quote.estimatedAmountOut.gt(new BN(0)) || !quote.otherAmountThreshold.gt(new BN(0))) {
    throw new Error('Pool cannot quote this amount');
  }
  const spotXeeuPerSol = PriceMath.sqrtPriceX64ToPrice(pool.sqrtPrice, 9, mint.decimals);
  const idealOutRaw = spotXeeuPerSol.mul(new Decimal(lamports.toString()).div(1e9))
    .mul(new Decimal(10).pow(mint.decimals));
  const quoteVsSpotPct = Decimal.max(0, new Decimal(1)
    .minus(new Decimal(quote.estimatedAmountOut.toString()).div(idealOutRaw)).mul(100)).toFixed(2);
  const extensionCtx = await TokenExtensionUtil.buildTokenExtensionContext(ctx.fetcher, pool);
  const hooks = await TokenExtensionUtil.getExtraAccountMetasForTransferHookForPool(
    connection, extensionCtx,
    wsolAta, pool.tokenVaultA, buyer,
    pool.tokenVaultB, xeeuAta, POOL,
  );
  if (!hooks.tokenTransferHookAccountsB?.length) throw new Error('Live hook account metas did not resolve');
  const swap = WhirlpoolIx.swapV2Ix(ctx.program, {
    ...quote, whirlpool: POOL, tokenMintA: NATIVE_MINT, tokenMintB: XEEU,
    tokenOwnerAccountA: wsolAta, tokenOwnerAccountB: xeeuAta,
    tokenVaultA: pool.tokenVaultA, tokenVaultB: pool.tokenVaultB,
    tokenTransferHookAccountsA: hooks.tokenTransferHookAccountsA,
    tokenTransferHookAccountsB: hooks.tokenTransferHookAccountsB,
    tokenProgramA: TOKEN_PROGRAM_ID, tokenProgramB: TOKEN_2022_PROGRAM_ID,
    oracle: PDAUtil.getOracle(PROGRAM, POOL).publicKey, tokenAuthority: buyer,
  });
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 450_000 }),
    SystemProgram.transfer({ fromPubkey: buyer, toPubkey: wsolAta, lamports: Number(lamports) }),
    createSyncNativeInstruction(wsolAta),
    ...instructions(swap),
  ];
  const tx = await unsignedTransaction(connection, buyer, ixs, 'Direct buy');
  return { status: 200, body: {
    chain: 'mainnet-beta', stage: 'swap', buyer: buyer.toBase58(),
    pool: POOL.toBase58(), hookProgram: HOOK.toBase58(),
    inputLamports: lamports.toString(),
    expectedXeeuRaw: quote.estimatedAmountOut.toString(),
    minimumXeeuRaw: quote.otherAmountThreshold.toString(),
    spotXeeuPerSol: spotXeeuPerSol.toFixed(4),
    quoteVsSpotPct,
    slippageBps: 100,
    message: 'Wallet signs one WSOL wrap plus Orca SwapV2. Price and minimum output are fixed in this transaction; network fees apply.',
    ...tx,
  } };
}

export function mountDirectBuy(app, connection) {
  const calls = new Map();
  app.post('/api/swap/prepare', async (request, response) => {
    const now = Date.now();
    const key = request.ip || 'unknown';
    const recent = (calls.get(key) || []).filter((at) => now - at < 60_000);
    if (recent.length >= 60) return response.status(429).json({ error: 'Too many quote requests; try again in one minute.' });
    recent.push(now); calls.set(key, recent);
    if (calls.size > 1000) for (const [ip, times] of calls) if (times.at(-1) < now - 60_000) calls.delete(ip);
    try {
      const result = await prepareDirectBuy(connection, request.body);
      response.set('Cache-Control', 'no-store');
      response.status(result.status).json(result.body);
    } catch (error) {
      console.error('[direct-buy] preparation failed:', error.message);
      const failure = tradeFailure(error);
      response.status(failure.status).json(failure.body);
    }
  });
  app.get('/api/swap/status/:signature', async (request, response) => {
    const { signature } = request.params;
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) return response.status(400).json({ error: 'Invalid signature.' });
    try {
      const [status] = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value;
      response.set('Cache-Control', 'no-store');
      response.json({ chain: 'mainnet-beta', signature,
        confirmationStatus: status?.confirmationStatus || null,
        err: status?.err || null,
        confirmed: Boolean(status && !status.err && ['confirmed', 'finalized'].includes(status.confirmationStatus)),
      });
    } catch {
      response.status(503).json({ error: 'Could not read transaction status.' });
    }
  });
}

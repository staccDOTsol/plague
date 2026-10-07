// Mainnet XEEu/WSOL launch. Each stage simulates before it may be executed.
// Run in order: setup, arrays, prepare, liquidity, swap.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from '@coral-xyz/anchor';
import { Percentage } from '@orca-so/common-sdk';
import {
  PDAUtil, PriceMath, TickUtil, TokenExtensionUtil, WhirlpoolContext,
  WhirlpoolIx, buildWhirlpoolClient, increaseLiquidityQuoteByInputTokenWithParams,
  swapQuoteByInputToken,
} from '@orca-so/whirlpools-sdk';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  createSyncNativeInstruction, getAccount, getAssociatedTokenAddressSync, getMint,
  getTransferHook,
} from '@solana/spl-token';
import {
  Connection, Keypair, PublicKey, SystemProgram, TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';

const PAYER = new PublicKey('331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth');
const FEE_AUTHORITY = new PublicKey('12Nqk2jyA3XNe3rPxAaLFixytmohnMrBfCsdwrCfWNm2');
const CONFIG = new PublicKey('HDE78Mg7ukJht34qd9yifnDGkdZoAFu5K5dSGQiHDDRq');
const PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const XEEU = new PublicKey('XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo');
const [MINT_A, MINT_B] = [NATIVE_MINT, XEEU];
const TICK_SPACING = 128;
const FEE_RATE = 3000; // 0.30%; Orca stores hundredths of a basis point.
const PRICE_B_PER_A = new Decimal(400_000);
const TICK_LOWER = 96_128;
const TICK_UPPER = 130_944;
const INPUT_XEEU_RAW = new BN('1000000000000000'); // Exactly 1,000,000 with 9 decimals.
const SWAP_WSOL_RAW = new BN('5000000'); // 0.005 SOL real test trade.
const MAX_POOL_WSOL_RAW = 300_000_000n;
const SLIPPAGE = Percentage.fromFraction(1, 100);
const POSITION_KEY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'secrets/first-trade-position.json');

function str(key) { return key.toBase58(); }
function expand(path) { return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path); }
function ixList(bundle) { return [...bundle.instructions, ...bundle.cleanupInstructions]; }

async function rpcUrl() {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  const handoff = process.env.HANDOFF_PATH
    ? await readFile(expand(process.env.HANDOFF_PATH), 'utf8') : '';
  const url = handoff.match(/https:\/\/mainnet\.helius-rpc\.com\/\?api-key=[a-zA-Z0-9-]+/)?.[0];
  if (!url) throw new Error('Provide RPC_URL or HANDOFF_PATH; no RPC key is stored in this script.');
  return url;
}

async function signer(path, expected) {
  const bytes = JSON.parse(await readFile(expand(path), 'utf8'));
  const kp = Keypair.fromSecretKey(Uint8Array.from(bytes));
  if (!kp.publicKey.equals(expected)) throw new Error(`Signer mismatch at ${path}`);
  return kp;
}

async function positionSigner() {
  let kp;
  try {
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(POSITION_KEY_PATH, 'utf8'))));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    kp = Keypair.generate();
    await mkdir(dirname(POSITION_KEY_PATH), { recursive: true, mode: 0o700 });
    await writeFile(POSITION_KEY_PATH, JSON.stringify([...kp.secretKey]), { flag: 'wx', mode: 0o600 });
  }
  return kp;
}

function quote(mintA, mintB, epoch) {
  const sqrtPrice = PriceMath.priceToSqrtPriceX64(PRICE_B_PER_A, mintA.decimals, mintB.decimals);
  const tickCurrentIndex = PriceMath.sqrtPriceX64ToTickIndex(sqrtPrice);
  const tokenExtensionCtx = {
    currentEpoch: epoch,
    tokenMintWithProgramA: { ...mintA, address: MINT_A, tokenProgram: TOKEN_PROGRAM_ID },
    tokenMintWithProgramB: { ...mintB, address: MINT_B, tokenProgram: TOKEN_2022_PROGRAM_ID },
  };
  const q = increaseLiquidityQuoteByInputTokenWithParams({
    inputTokenMint: XEEU,
    inputTokenAmount: INPUT_XEEU_RAW,
    tokenMintA: MINT_A,
    tokenMintB: MINT_B,
    tickCurrentIndex,
    sqrtPrice,
    tickLowerIndex: TICK_LOWER,
    tickUpperIndex: TICK_UPPER,
    slippageTolerance: SLIPPAGE,
    tokenExtensionCtx,
  });
  if (BigInt(q.tokenMaxA.toString()) > MAX_POOL_WSOL_RAW) {
    throw new Error(`Liquidity quote exceeds 0.3 WSOL limit: ${q.tokenMaxA}`);
  }
  if (BigInt(q.tokenEstB.toString()) > BigInt(INPUT_XEEU_RAW.toString())) {
    throw new Error('Quote demands more than 1,000,000 XEEu');
  }
  return { sqrtPrice, tickCurrentIndex, q, tokenExtensionCtx };
}

function pda() {
  const feeTier = PDAUtil.getFeeTier(PROGRAM, CONFIG, TICK_SPACING);
  const pool = PDAUtil.getWhirlpool(PROGRAM, CONFIG, MINT_A, MINT_B, TICK_SPACING);
  const badgeA = PDAUtil.getTokenBadge(PROGRAM, CONFIG, MINT_A);
  const badgeB = PDAUtil.getTokenBadge(PROGRAM, CONFIG, MINT_B);
  const starts = [...new Set([
    TickUtil.getStartTickIndex(TICK_LOWER, TICK_SPACING),
    TickUtil.getStartTickIndex(TICK_UPPER, TICK_SPACING),
    TickUtil.getStartTickIndex(TICK_UPPER, TICK_SPACING, 1),
    TickUtil.getStartTickIndex(TICK_UPPER, TICK_SPACING, 2),
  ])];
  return { feeTier, pool, badgeA, badgeB, starts };
}

async function transmit(connection, label, instructions, extraSigners = [], execute = false) {
  if (!instructions.length) { console.log(`${label}: already complete`); return null; }
  const latest = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: PAYER,
    recentBlockhash: latest.blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const bytes = tx.serialize().length;
  if (bytes > 1232) throw new Error(`${label}: transaction too large (${bytes} bytes)`);
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' });
  if (sim.value.err) {
    console.error(sim.value.logs?.slice(-25).join('\n'));
    throw new Error(`${label} simulation failed: ${JSON.stringify(sim.value.err)}`);
  }
  console.log(`${label}: simulation passed, ${bytes} bytes, ${sim.value.unitsConsumed} CUs`);
  if (!execute) return null;
  const payer = await signer(process.env.FEE_PAYER || '~/hooked.json', PAYER);
  const feeSignerRequired = message.staticAccountKeys.some((k, i) =>
    i < message.header.numRequiredSignatures && k.equals(FEE_AUTHORITY));
  const feeSigner = feeSignerRequired
    ? await signer(process.env.FEE_AUTHORITY_KEY || '~/.config/solana/id.json', FEE_AUTHORITY) : null;
  tx.sign([payer, ...(feeSigner ? [feeSigner] : []), ...extraSigners]);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const confirmed = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  if (confirmed.value.err) throw new Error(`${label} failed: ${JSON.stringify(confirmed.value.err)}; signature ${signature}`);
  console.log(`${label}: confirmed ${signature}`);
  return signature;
}

async function main() {
  const stage = process.argv.find((a) => a.startsWith('--stage='))?.slice('--stage='.length) ?? 'plan';
  const execute = process.argv.includes('--execute');
  if (!['plan', 'setup', 'arrays', 'prepare', 'liquidity', 'swap'].includes(stage)) throw new Error(`Unknown stage ${stage}`);
  if (stage === 'plan' && execute) throw new Error('Plan is read-only.');
  const connection = new Connection(await rpcUrl(), 'confirmed');
  const genesis = await connection.getGenesisHash();
  if (!genesis.startsWith('5eykt4')) throw new Error(`Expected Solana mainnet, got ${genesis}`);
  const ctx = WhirlpoolContext.from(connection, new Wallet(Keypair.generate()), undefined, undefined, {}, PROGRAM);
  const [mintA, mintB, epoch, configAccount] = await Promise.all([
    getMint(connection, MINT_A, 'confirmed', TOKEN_PROGRAM_ID),
    getMint(connection, MINT_B, 'confirmed', TOKEN_2022_PROGRAM_ID),
    connection.getEpochInfo('confirmed'),
    ctx.fetcher.getConfig(CONFIG),
  ]);
  if (!configAccount?.feeAuthority.equals(FEE_AUTHORITY)) throw new Error('HDE fee authority changed');
  if (!mintB.mintAuthority?.equals(PAYER)) throw new Error('331n no longer controls XEEu mint authority');
  const hook = getTransferHook(mintB);
  if (!hook?.programId) throw new Error('XEEu has no transfer hook program');
  const { feeTier, pool, badgeA, badgeB, starts } = pda();
  const { sqrtPrice, tickCurrentIndex, q, tokenExtensionCtx } = quote(mintA, mintB, epoch.epoch);
  const actualPoolAccount = await connection.getAccountInfo(pool.publicKey, 'confirmed');
  const badgeAccount = await connection.getAccountInfo(badgeB.publicKey, 'confirmed');
  if (!badgeAccount?.owner.equals(PROGRAM)) throw new Error('XEEu TokenBadge missing from HDE config');
  const programInfo = await connection.getAccountInfo(hook.programId, 'confirmed');
  if (!programInfo?.executable) throw new Error(`XEEu hook program ${str(hook.programId)} is not executable`);
  console.log(JSON.stringify({
    stage, execute, pool: str(pool.publicKey), feeTier: str(feeTier.publicKey),
    hookProgram: str(hook.programId), tickSpacing: TICK_SPACING, feeRate: FEE_RATE,
    openingPriceXeeuPerSol: PRICE_B_PER_A.toString(), tickCurrentIndex,
    ticks: [TICK_LOWER, TICK_UPPER],
    depositXeeu: new Decimal(q.tokenEstB.toString()).div(1e9).toString(),
    depositWsol: new Decimal(q.tokenEstA.toString()).div(1e9).toString(),
    maxWsol: new Decimal(q.tokenMaxA.toString()).div(1e9).toString(),
    existingPool: !!actualPoolAccount,
  }, null, 2));
  if (stage === 'plan') return;

  if (stage === 'setup') {
    if (actualPoolAccount) throw new Error('Pool already exists; setup must not overwrite it');
    const vaultA = Keypair.generate();
    const vaultB = Keypair.generate();
    const feeTierExists = !!(await connection.getAccountInfo(feeTier.publicKey, 'confirmed'));
    const ixs = [];
    if (!feeTierExists) ixs.push(...ixList(WhirlpoolIx.initializeFeeTierIx(ctx.program, {
      whirlpoolsConfig: CONFIG, feeTierPda: feeTier, tickSpacing: TICK_SPACING,
      defaultFeeRate: FEE_RATE, feeAuthority: FEE_AUTHORITY, funder: PAYER,
    })));
    ixs.push(...ixList(WhirlpoolIx.initializePoolV2Ix(ctx.program, {
      initSqrtPrice: sqrtPrice, whirlpoolsConfig: CONFIG, whirlpoolPda: pool,
      tokenMintA: MINT_A, tokenMintB: MINT_B, tokenBadgeA: badgeA.publicKey,
      tokenBadgeB: badgeB.publicKey, tokenProgramA: TOKEN_PROGRAM_ID,
      tokenProgramB: TOKEN_2022_PROGRAM_ID, tokenVaultAKeypair: vaultA,
      tokenVaultBKeypair: vaultB, feeTierKey: feeTier.publicKey,
      tickSpacing: TICK_SPACING, funder: PAYER,
    })));
    await transmit(connection, 'setup fee tier + pool', ixs, [vaultA, vaultB], execute);
    return;
  }

  if (!actualPoolAccount?.owner.equals(PROGRAM)) throw new Error('Pool is not initialized; run setup first');
  const poolData = await ctx.fetcher.getPool(pool.publicKey);
  if (!poolData || poolData.tickSpacing !== TICK_SPACING || !poolData.tokenMintA.equals(MINT_A) || !poolData.tokenMintB.equals(MINT_B)) {
    throw new Error('Existing pool differs from planned mints/spacing');
  }
  const livePrice = PriceMath.sqrtPriceX64ToPrice(poolData.sqrtPrice, mintA.decimals, mintB.decimals);
  console.log(`Live pool price: ${livePrice.toString()} XEEu/SOL`);

  if (stage === 'arrays') {
    const ixs = [];
    for (const startTick of starts) {
      const tickArrayPda = PDAUtil.getTickArray(PROGRAM, pool.publicKey, startTick);
      if (await connection.getAccountInfo(tickArrayPda.publicKey, 'confirmed')) continue;
      ixs.push(...ixList(WhirlpoolIx.initDynamicTickArrayIx(ctx.program, {
        whirlpool: pool.publicKey, tickArrayPda, startTick, funder: PAYER,
      })));
    }
    await transmit(connection, `initialize ${ixs.length} tick arrays`, ixs, [], execute);
    return;
  }

  const ownerA = getAssociatedTokenAddressSync(MINT_A, PAYER);
  const ownerB = getAssociatedTokenAddressSync(MINT_B, PAYER, false, TOKEN_2022_PROGRAM_ID);
  if (stage === 'prepare') {
    const ixs = [
      createAssociatedTokenAccountIdempotentInstruction(PAYER, ownerA, PAYER, MINT_A, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(PAYER, ownerB, PAYER, MINT_B, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    ];
    const existingWsol = await getAccount(connection, ownerA, 'confirmed', TOKEN_PROGRAM_ID).catch(() => null);
    const deficit = BigInt(q.tokenMaxA.toString()) - (existingWsol?.amount ?? 0n);
    if (deficit > 0n) {
      ixs.push(SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: ownerA, lamports: Number(deficit) }));
      ixs.push(createSyncNativeInstruction(ownerA));
    }
    await transmit(connection, 'prepare ATAs + WSOL', ixs, [], execute);
    return;
  }

  if (stage === 'liquidity') {
    const positionMint = await positionSigner();
    const position = PDAUtil.getPosition(PROGRAM, positionMint.publicKey);
    if (await connection.getAccountInfo(position.publicKey, 'confirmed')) {
      throw new Error(`Position ${str(position.publicKey)} already exists; refusing to mint another 1,000,000 XEEu`);
    }
    const ownerWsol = await getAccount(connection, ownerA, 'confirmed', TOKEN_PROGRAM_ID);
    if (ownerWsol.amount < BigInt(q.tokenMaxA.toString())) throw new Error('WSOL ATA underfunded; run prepare');
    const ownerXeeu = await getAccount(connection, ownerB, 'confirmed', TOKEN_2022_PROGRAM_ID);
    const tickArrayLower = PDAUtil.getTickArray(PROGRAM, pool.publicKey, TickUtil.getStartTickIndex(TICK_LOWER, TICK_SPACING)).publicKey;
    const tickArrayUpper = PDAUtil.getTickArray(PROGRAM, pool.publicKey, TickUtil.getStartTickIndex(TICK_UPPER, TICK_SPACING)).publicKey;
    if (!(await connection.getAccountInfo(tickArrayLower)) || !(await connection.getAccountInfo(tickArrayUpper))) {
      throw new Error('Tick arrays missing; run arrays');
    }
    if (!poolData.sqrtPrice.eq(sqrtPrice)) throw new Error('Pool price moved before first LP; requote before minting');
    const positionTokenAccount = getAssociatedTokenAddressSync(positionMint.publicKey, PAYER);
    const hooks = await TokenExtensionUtil.getExtraAccountMetasForTransferHookForPool(
      connection, tokenExtensionCtx, ownerA, poolData.tokenVaultA, PAYER,
      ownerB, poolData.tokenVaultB, PAYER,
    );
    if (!hooks.tokenTransferHookAccountsB?.length) throw new Error('XEEu hook extra account metas unresolved');
    const ixs = [
      createMintToInstruction(XEEU, ownerB, PAYER, BigInt(INPUT_XEEU_RAW.toString()), [], TOKEN_2022_PROGRAM_ID),
      ...ixList(WhirlpoolIx.openPositionIx(ctx.program, {
        whirlpool: pool.publicKey, owner: PAYER, positionPda: position,
        positionMintAddress: positionMint.publicKey, positionTokenAccount,
        tickLowerIndex: TICK_LOWER, tickUpperIndex: TICK_UPPER, funder: PAYER,
      })),
      ...ixList(WhirlpoolIx.increaseLiquidityV2Ix(ctx.program, {
        whirlpool: pool.publicKey, position: position.publicKey, positionTokenAccount,
        positionAuthority: PAYER, tokenMintA: MINT_A, tokenMintB: MINT_B,
        tokenOwnerAccountA: ownerA, tokenOwnerAccountB: ownerB,
        tokenVaultA: poolData.tokenVaultA, tokenVaultB: poolData.tokenVaultB,
        tokenTransferHookAccountsA: hooks.tokenTransferHookAccountsA,
        tokenTransferHookAccountsB: hooks.tokenTransferHookAccountsB,
        tokenProgramA: TOKEN_PROGRAM_ID, tokenProgramB: TOKEN_2022_PROGRAM_ID,
        tickArrayLower, tickArrayUpper, liquidityAmount: q.liquidityAmount,
        tokenMaxA: q.tokenMaxA, tokenMaxB: q.tokenMaxB,
      })),
    ];
    console.log(`Position ${str(position.publicKey)}, hook B metas ${hooks.tokenTransferHookAccountsB.length}`);
    await transmit(connection, 'mint 1m XEEu + open/increase liquidity', ixs, [positionMint], execute);
    return;
  }

  if (stage === 'swap') {
    if (poolData.liquidity.isZero()) throw new Error('Pool has no liquidity; run liquidity');
    const whirlpool = await buildWhirlpoolClient(ctx).getPool(pool.publicKey);
    const swapQuote = await swapQuoteByInputToken(
      whirlpool, MINT_A, SWAP_WSOL_RAW, SLIPPAGE, PROGRAM, ctx.fetcher,
    );
    const hooks = await TokenExtensionUtil.getExtraAccountMetasForTransferHookForPool(
      connection, await TokenExtensionUtil.buildTokenExtensionContext(ctx.fetcher, poolData),
      ownerA, poolData.tokenVaultA, PAYER, poolData.tokenVaultB, ownerB, pool.publicKey,
    );
    if (!hooks.tokenTransferHookAccountsB?.length) throw new Error('Swap hook extra account metas unresolved');
    const ownerWsol = await getAccount(connection, ownerA, 'confirmed', TOKEN_PROGRAM_ID);
    const deficit = BigInt(SWAP_WSOL_RAW.toString()) - ownerWsol.amount;
    const ixs = [];
    if (deficit > 0n) {
      ixs.push(SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: ownerA, lamports: Number(deficit) }));
      ixs.push(createSyncNativeInstruction(ownerA));
    }
    ixs.push(...ixList(WhirlpoolIx.swapV2Ix(ctx.program, {
      ...swapQuote, whirlpool: pool.publicKey, tokenMintA: MINT_A, tokenMintB: MINT_B,
      tokenOwnerAccountA: ownerA, tokenOwnerAccountB: ownerB,
      tokenVaultA: poolData.tokenVaultA, tokenVaultB: poolData.tokenVaultB,
      tokenTransferHookAccountsA: hooks.tokenTransferHookAccountsA,
      tokenTransferHookAccountsB: hooks.tokenTransferHookAccountsB,
      tokenProgramA: TOKEN_PROGRAM_ID, tokenProgramB: TOKEN_2022_PROGRAM_ID,
      oracle: PDAUtil.getOracle(PROGRAM, pool.publicKey).publicKey, tokenAuthority: PAYER,
    })));
    console.log(`Swap 0.005 WSOL input, expected ${new Decimal(swapQuote.estimatedAmountOut.toString()).div(1e9)} XEEu, minimum ${new Decimal(swapQuote.otherAmountThreshold.toString()).div(1e9)} XEEu`);
    await transmit(connection, 'direct swap_v2 WSOL -> XEEu', ixs, [], execute);
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

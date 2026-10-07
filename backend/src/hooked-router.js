// Hook-aware, wallet-signed execution for all three controlled mints. SOL
// routes are atomic, including the USDC/GGo8 bridges; every prepared packet is
// simulated. There is no wallet keypair in this module.
import { Wallet } from '@coral-xyz/anchor';
import { Percentage } from '@orca-so/common-sdk';
import {
  PDAUtil, PriceMath, TokenExtensionUtil, WhirlpoolContext, WhirlpoolIx,
  buildWhirlpoolClient, swapQuoteByInputToken, swapQuoteByOutputToken,
  twoHopSwapQuoteFromSwapQuotes,
} from '@orca-so/whirlpools-sdk';
import {
  CpmmConfigInfoLayout, CpmmPoolInfoLayout, CurveCalculator,
  makeSwapCpmmBaseInInstruction, makeSwapCpmmBaseOutInstruction,
} from '@raydium-io/raydium-sdk-v2';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, createSyncNativeInstruction,
  createTransferCheckedWithTransferHookInstruction, getAssociatedTokenAddressSync,
  getTransferFeeConfig, getTransferHook, unpackMint,
} from '@solana/spl-token';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { CPMM, CPMM_AUTHORITY, CONTROLLER, ORCA, WSOL, GGO8, SOL_GGO8_POOL, routeCandidates } from './router-markets.js';
import { requireHolder } from './wallet-holdings.js';
import { TradeError } from './trade-errors.js';

const key = (value) => new PublicKey(value);
const bn = (value) => new BN(String(value));
const ZERO_SLIPPAGE = Percentage.fromFraction(0, 10000);
const SLIPPAGE = Percentage.fromFraction(100, 10000);
const ixs = (bundle) => [...bundle.instructions, ...bundle.cleanupInstructions];
const positive = (value) => value && !value.isZero();
const minimum = (value) => BN.max(bn(1), value.muln(10000).divn(10100));

async function mintInfo(connection, address) {
  const info = await connection.getAccountInfo(key(address), 'confirmed');
  if (!info || (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID))) {
    throw new TradeError(422, 'MINT_UNAVAILABLE', 'A route mint is not an initialized SPL token.');
  }
  return { ...unpackMint(key(address), info, info.owner), tokenProgram: info.owner };
}

async function loadCp(connection) {
  const info = await connection.getAccountInfo(key(SOL_GGO8_POOL), 'confirmed');
  if (!info?.owner.equals(key(CPMM))) throw new TradeError(422, 'BRIDGE_UNAVAILABLE', 'The SOL/GGo8 bridge is unavailable.');
  const pool = CpmmPoolInfoLayout.decode(info.data);
  if (![pool.mintA.toBase58(), pool.mintB.toBase58()].includes(WSOL) ||
      ![pool.mintA.toBase58(), pool.mintB.toBase58()].includes(GGO8)) {
    throw new TradeError(422, 'BRIDGE_CHANGED', 'The bridge pool mints changed.');
  }
  const [config, a, b] = await connection.getMultipleAccountsInfo([pool.configId, pool.vaultA, pool.vaultB], 'confirmed');
  if (!config?.owner.equals(key(CPMM)) || !a || !b) throw new TradeError(422, 'BRIDGE_UNAVAILABLE', 'The bridge config or vaults are unavailable.');
  const fees = CpmmConfigInfoLayout.decode(config.data);
  const reserveA = bn(a.data.readBigUInt64LE(64)).sub(pool.protocolFeesMintA).sub(pool.fundFeesMintA).sub(pool.creatorFeesMintA);
  const reserveB = bn(b.data.readBigUInt64LE(64)).sub(pool.protocolFeesMintB).sub(pool.fundFeesMintB).sub(pool.creatorFeesMintB);
  if (!positive(reserveA) || !positive(reserveB)) throw new TradeError(422, 'BRIDGE_EMPTY', 'The SOL/GGo8 bridge has no active reserves.');
  return { pool, fees, reserveA, reserveB };
}

function cpQuote(cp, inputMint, amount, exactOut = false) {
  const inputA = cp.pool.mintA.toBase58() === inputMint;
  const creatorOnInput = cp.pool.feeOn === 0 || (cp.pool.feeOn === 1 && inputA) || (cp.pool.feeOn === 2 && !inputA);
  const creatorRate = cp.pool.enableCreatorFee ? cp.fees.creatorFeeRate : bn(0);
  return CurveCalculator[exactOut ? 'swapBaseOutput' : 'swapBaseInput'](
    amount, inputA ? cp.reserveA : cp.reserveB, inputA ? cp.reserveB : cp.reserveA,
    cp.fees.tradeFeeRate, creatorRate, cp.fees.protocolFeeRate, cp.fees.fundFeeRate, creatorOnInput,
  );
}

function cpIx(cp, buyer, inputMint, inputAccount, outputAccount, amount, threshold, exactOut) {
  const inputA = cp.pool.mintA.toBase58() === inputMint;
  const make = exactOut ? makeSwapCpmmBaseOutInstruction : makeSwapCpmmBaseInInstruction;
  return make(key(CPMM), buyer, key(CPMM_AUTHORITY), cp.pool.configId, key(SOL_GGO8_POOL),
    inputAccount, outputAccount, inputA ? cp.pool.vaultA : cp.pool.vaultB,
    inputA ? cp.pool.vaultB : cp.pool.vaultA, inputA ? cp.pool.mintProgramA : cp.pool.mintProgramB,
    inputA ? cp.pool.mintProgramB : cp.pool.mintProgramA, inputA ? cp.pool.mintA : cp.pool.mintB,
    inputA ? cp.pool.mintB : cp.pool.mintA, cp.pool.observationId,
    exactOut ? threshold : amount, exactOut ? amount : threshold);
}

function step(pool, input, output, inAmount, outAmount, label = 'Orca Whirlpools V2') {
  return { percent: 100, swapInfo: { ammKey: pool, label, inputMint: input, outputMint: output,
    inAmount: inAmount.toString(), outAmount: outAmount.toString() } };
}

export async function quoteRoute(connection, candidate, amountRaw) {
  const ctx = WhirlpoolContext.from(connection, new Wallet(Keypair.generate()), undefined, undefined, {}, key(ORCA));
  const client = buildWhirlpoolClient(ctx);
  const tokens = await Promise.all(candidate.mints.map((mint) => mintInfo(connection, mint)));
  const controlled = tokens[candidate.buying ? tokens.length - 1 : 0];
  const hook = getTransferHook(controlled);
  if (!hook?.authority?.equals(key(CONTROLLER)) || !hook.programId || hook.programId.equals(PublicKey.default)) {
    throw new TradeError(422, 'HOOK_AUTHORITY_CHANGED', 'The selected mint no longer has a controlled, active hook.');
  }
  const pools = await Promise.all(candidate.pools.map((address) => address === SOL_GGO8_POOL ? null : client.getPool(key(address))));
  pools.forEach((pool, i) => {
    if (!pool) return;
    const data = pool.getData();
    const expected = [candidate.mints[i], candidate.mints[i + 1]];
    if (!expected.includes(data.tokenMintA.toBase58()) || !expected.includes(data.tokenMintB.toBase58()) || data.liquidity.isZero()) {
      throw new TradeError(422, 'POOL_UNAVAILABLE', 'A selected Whirlpool has no active liquidity or its mints changed.');
    }
  });
  const amount = bn(amountRaw);
  const quote = (pool, input, raw, slippage = SLIPPAGE) => swapQuoteByInputToken(pool, key(input), raw, slippage, key(ORCA), ctx.fetcher);
  let quotes, cp, intermediate, estimatedInput = amount, amountMode = 'exact';
  let output, minOutput, plan;
  if (candidate.kind === 'orca') {
    const q = await quote(pools[0], candidate.mints[0], amount);
    if (positive(q.estimatedAmountOut) && q.otherAmountThreshold.isZero()) q.otherAmountThreshold = bn(1);
    quotes = [q]; output = q.estimatedAmountOut; minOutput = q.otherAmountThreshold;
    plan = [step(candidate.pools[0], candidate.mints[0], candidate.mints[1], amount, output)];
  } else if (candidate.kind === 'orca-two-hop') {
    const first = await quote(pools[0], candidate.mints[0], amount, ZERO_SLIPPAGE);
    const second = await quote(pools[1], candidate.mints[1], first.estimatedAmountOut);
    if (positive(second.estimatedAmountOut) && second.otherAmountThreshold.isZero()) second.otherAmountThreshold = bn(1);
    quotes = [first, second]; output = second.estimatedAmountOut; minOutput = second.otherAmountThreshold;
    plan = [step(candidate.pools[0], candidate.mints[0], candidate.mints[1], amount, first.estimatedAmountOut),
      step(candidate.pools[1], candidate.mints[1], candidate.mints[2], first.estimatedAmountOut, output)];
  } else {
    // Exact-output bridge stages cap input and produce a deterministic amount
    // for the next program. Intermediate tokens are consumed in the same packet.
    // Unspent input is returned/retained by the wallet, never sent to the server.
    cp = await loadCp(connection);
    if (getTransferFeeConfig(tokens.find((mint) => mint.address.equals(key(GGO8))))) {
      throw new TradeError(422, 'BRIDGE_FEE_CHANGED', 'The bridge token transfer-fee configuration changed; this route needs revalidation.');
    }
    amountMode = 'max';
    if (candidate.buying) {
      const first = cpQuote(cp, WSOL, amount);
      intermediate = first.outputAmount.muln(99).divn(100);
      const needed = cpQuote(cp, WSOL, intermediate, true);
      estimatedInput = needed.inputAmount;
      if (estimatedInput.gt(amount)) throw new TradeError(409, 'BRIDGE_PRICE_MOVED', 'The bridge price moved beyond your maximum input. Refresh.');
      const second = await quote(pools[1], GGO8, intermediate);
      if (positive(second.estimatedAmountOut) && second.otherAmountThreshold.isZero()) second.otherAmountThreshold = bn(1);
      quotes = [null, second]; output = second.estimatedAmountOut; minOutput = second.otherAmountThreshold;
      plan = [step(SOL_GGO8_POOL, WSOL, GGO8, estimatedInput, intermediate, 'Raydium CP'),
        step(candidate.pools[1], GGO8, candidate.market.mint, intermediate, output)];
    } else {
      const first = await quote(pools[0], candidate.market.mint, amount, ZERO_SLIPPAGE);
      intermediate = first.estimatedAmountOut.muln(99).divn(100);
      const exact = await swapQuoteByOutputToken(pools[0], key(GGO8), intermediate, ZERO_SLIPPAGE, key(ORCA), ctx.fetcher);
      estimatedInput = exact.estimatedAmountIn;
      if (estimatedInput.gt(amount)) throw new TradeError(409, 'BRIDGE_PRICE_MOVED', 'The market price moved beyond your maximum input. Refresh.');
      exact.otherAmountThreshold = amount;
      const second = cpQuote(cp, GGO8, intermediate);
      quotes = [exact, null]; output = second.outputAmount; minOutput = minimum(output);
      plan = [step(candidate.pools[0], candidate.market.mint, GGO8, estimatedInput, intermediate),
        step(SOL_GGO8_POOL, GGO8, WSOL, intermediate, output, 'Raydium CP')];
    }
  }
  if (!positive(output) || !positive(minOutput) || (intermediate && !positive(intermediate))) {
    throw new TradeError(400, 'AMOUNT_TOO_SMALL', 'This amount is too small to produce a nonzero output.');
  }
  let spotRaw = new Decimal(1);
  for (let i = 0; i < candidate.pools.length; i++) {
    if (pools[i]) {
      const data = pools[i].getData();
      const a = tokens.find((token) => token.address.equals(data.tokenMintA));
      const b = tokens.find((token) => token.address.equals(data.tokenMintB));
      let price = PriceMath.sqrtPriceX64ToPrice(data.sqrtPrice, a.decimals, b.decimals);
      if (data.tokenMintA.toBase58() !== candidate.mints[i]) price = new Decimal(1).div(price);
      spotRaw = spotRaw.mul(price).mul(new Decimal(10).pow(tokens[i + 1].decimals - tokens[i].decimals));
    } else {
      const inputA = cp.pool.mintA.toBase58() === candidate.mints[i];
      spotRaw = spotRaw.mul(new Decimal((inputA ? cp.reserveB : cp.reserveA).toString())
        .div((inputA ? cp.reserveA : cp.reserveB).toString()));
    }
  }
  const impact = Decimal.max(0, new Decimal(1).minus(new Decimal(output.toString())
    .div(spotRaw.mul(estimatedInput.toString()))));
  return { candidate, ctx, tokens, pools, quotes, cp, intermediate, amount, estimatedInput,
    output, minOutput, hookProgram: hook.programId.toBase58(),
    publicQuote: { routeKind: 'hooked-orca', inputMint: candidate.mints[0], outputMint: candidate.mints.at(-1),
      inAmount: amount.toString(), outAmount: output.toString(), otherAmountThreshold: minOutput.toString(),
      estimatedInputRaw: estimatedInput.toString(), amountMode, priceImpactPct: impact.toFixed(8), routePlan: plan,
      contextSlot: await connection.getSlot('confirmed'), transaction: null, swapType: 'captainhook-direct',
      gasless: false, requestId: `captainhook-${Date.now()}`, slippageBps: 100, feeBps: 0,
      router: 'captainhook', platformFee: { feeBps: 0 }, prioritizationFeePayer: null,
      rentFeePayer: null, signatureFeePayer: null, signatureFeeLamports: 5000,
      hookProgram: hook.programId.toBase58(), marketMint: candidate.market.mint,
      simulation: { passed: false, stage: 'preview' } } };
}

async function swapOne(connection, route, i, buyer, accounts) {
  const pool = route.pools[i], data = pool.getData(), q = route.quotes[i];
  const a = accounts.get(data.tokenMintA.toBase58()), b = accounts.get(data.tokenMintB.toBase58());
  const extension = await TokenExtensionUtil.buildTokenExtensionContext(route.ctx.fetcher, data);
  const hooks = await TokenExtensionUtil.getExtraAccountMetasForTransferHookForPool(connection, extension,
    q.aToB ? a : data.tokenVaultA, q.aToB ? data.tokenVaultA : a, q.aToB ? buyer : key(route.candidate.pools[i]),
    q.aToB ? data.tokenVaultB : b, q.aToB ? b : data.tokenVaultB, q.aToB ? key(route.candidate.pools[i]) : buyer);
  return ixs(WhirlpoolIx.swapV2Ix(route.ctx.program, { ...q, whirlpool: key(route.candidate.pools[i]),
    tokenMintA: data.tokenMintA, tokenMintB: data.tokenMintB, tokenOwnerAccountA: a, tokenOwnerAccountB: b,
    tokenVaultA: data.tokenVaultA, tokenVaultB: data.tokenVaultB,
    tokenProgramA: extension.tokenMintWithProgramA.tokenProgram, tokenProgramB: extension.tokenMintWithProgramB.tokenProgram,
    ...hooks, oracle: PDAUtil.getOracle(key(ORCA), key(route.candidate.pools[i])).publicKey, tokenAuthority: buyer }));
}

async function swapTwo(connection, route, buyer, accounts) {
  const [one, two] = route.pools.map((pool) => pool.getData());
  const [q1, q2] = route.quotes;
  const [input, middle, output] = route.tokens;
  const vaultIn = q1.aToB ? one.tokenVaultA : one.tokenVaultB;
  const vaultMiddleOne = q1.aToB ? one.tokenVaultB : one.tokenVaultA;
  const vaultMiddleTwo = q2.aToB ? two.tokenVaultA : two.tokenVaultB;
  const vaultOut = q2.aToB ? two.tokenVaultB : two.tokenVaultA;
  const [inputHook, middleHook, outputHook] = await Promise.all([
    TokenExtensionUtil.getExtraAccountMetasForTransferHook(connection, input, accounts.get(input.address.toBase58()), vaultIn, buyer),
    TokenExtensionUtil.getExtraAccountMetasForTransferHook(connection, middle, vaultMiddleOne, vaultMiddleTwo, key(route.candidate.pools[0])),
    TokenExtensionUtil.getExtraAccountMetasForTransferHook(connection, output, vaultOut, accounts.get(output.address.toBase58()), key(route.candidate.pools[1])),
  ]);
  return ixs(WhirlpoolIx.twoHopSwapV2Ix(route.ctx.program, { ...twoHopSwapQuoteFromSwapQuotes(q1, q2),
    whirlpoolOne: key(route.candidate.pools[0]), whirlpoolTwo: key(route.candidate.pools[1]),
    tokenMintInput: input.address, tokenMintIntermediate: middle.address, tokenMintOutput: output.address,
    tokenProgramInput: input.tokenProgram, tokenProgramIntermediate: middle.tokenProgram, tokenProgramOutput: output.tokenProgram,
    tokenOwnerAccountInput: accounts.get(input.address.toBase58()), tokenOwnerAccountOutput: accounts.get(output.address.toBase58()),
    tokenVaultOneInput: vaultIn, tokenVaultOneIntermediate: vaultMiddleOne, tokenVaultTwoIntermediate: vaultMiddleTwo, tokenVaultTwoOutput: vaultOut,
    tokenTransferHookAccountsInput: inputHook, tokenTransferHookAccountsIntermediate: middleHook, tokenTransferHookAccountsOutput: outputHook,
    oracleOne: PDAUtil.getOracle(key(ORCA), key(route.candidate.pools[0])).publicKey,
    oracleTwo: PDAUtil.getOracle(key(ORCA), key(route.candidate.pools[1])).publicKey, tokenAuthority: buyer }));
}

export async function simulatePacket(connection, buyer, instructions, label) {
  if (!instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2)) {
    instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instructions];
  }
  if (!instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 1)) {
    instructions = [ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }), ...instructions];
  }
  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: buyer,
    recentBlockhash: latest.blockhash, instructions }).compileToV0Message());
  if (tx.serialize().length > 1232) throw new TradeError(422, 'TRANSACTION_TOO_LARGE',
    'This complete route exceeds the Solana packet limit and needs an address lookup table.');
  const simulation = await connection.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed', replaceRecentBlockhash: true });
  if (simulation.value.err) {
    const logs = simulation.value.logs || [];
    if (typeof simulation.value.err === 'object' && 'InsufficientFundsForRent' in simulation.value.err) {
      throw new TradeError(409, 'INSUFFICIENT_SOL_FOR_RENT',
        'This wallet needs more SOL to create its token accounts and pay network fees. Token-account rent is refundable when those accounts are closed.');
    }
    if (logs.some((line) => line.includes('existing holders only'))) throw new TradeError(403, 'EXISTING_HOLDER_REQUIRED',
      'The hook rejected this transfer: the recipient must already hold the same mint before receiving more.');
    if (logs.some((line) => /insufficient (funds|lamports)/i.test(line))) throw new TradeError(409, 'INSUFFICIENT_BALANCE',
      'Insufficient input tokens or SOL for this transaction and network fees.');
    if (logs.some((line) => /threshold|slippage/i.test(line))) throw new TradeError(409, 'PRICE_MOVED', 'The pool price moved beyond this quote. Refresh it.');
    const detail = logs.filter((line) => line.startsWith('Program log:') || line.includes('failed:')).slice(-4).join(' ');
    throw new TradeError(409, 'SIMULATION_FAILED', `${label} cannot execute: ${detail || JSON.stringify(simulation.value.err)}`);
  }
  return { tx, public: { transaction: Buffer.from(tx.serialize()).toString('base64'),
    blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight,
    computeUnits: simulation.value.unitsConsumed, transactionBytes: tx.serialize().length,
    simulatedAt: new Date().toISOString() } };
}

export async function prepareRoute(connection, route, buyer) {
  const held = await requireHolder(connection, buyer, route.candidate.market);
  const neededMints = route.candidate.kind === 'raydium-orca' ? route.tokens : [route.tokens[0], route.tokens.at(-1)];
  const accounts = new Map(neededMints.map((mint) => [mint.address.toBase58(), getAssociatedTokenAddressSync(mint.address, buyer, false, mint.tokenProgram)]));
  const infoList = await connection.getMultipleAccountsInfo([...accounts.values()], 'confirmed');
  const infos = new Map([...accounts.keys()].map((mint, i) => [mint, infoList[i]]));
  const setup = [];
  for (const mint of neededMints) {
    const info = infos.get(mint.address.toBase58());
    if (info && (!info.owner.equals(mint.tokenProgram) || !info.data.subarray(0, 32).equals(mint.address.toBuffer()) ||
      !info.data.subarray(32, 64).equals(buyer.toBuffer()))) throw new TradeError(409, 'TOKEN_ACCOUNT_CHANGED', 'A wallet token account has an unexpected owner or mint.');
    if (!info) setup.push(createAssociatedTokenAccountIdempotentInstruction(buyer, accounts.get(mint.address.toBase58()), buyer, mint.address, mint.tokenProgram));
  }
  // Existing holders with non-ATA holdings can seed/consolidate their own ATA.
  // This is a same-owner transfer, not a grant or a new-holder exception.
  const own = infos.get(route.candidate.market.mint);
  const canonicalAmount = own ? own.data.readBigUInt64LE(64) : 0n;
  const required = route.candidate.buying ? 1n : BigInt(route.amount.toString());
  const sourceTransfers = [];
  if (canonicalAmount < required) {
    let remaining = required - canonicalAmount;
    for (const source of held.accounts.filter((account) => !account.address.equals(held.canonical) && account.amount > 0n)) {
      const move = source.amount < remaining ? source.amount : remaining;
      sourceTransfers.push({ source: source.address.toBase58(), amountRaw: move.toString() });
      const planned = Buffer.alloc(165); key(route.candidate.market.mint).toBuffer().copy(planned); buyer.toBuffer().copy(planned, 32);
      const resolver = { getAccountInfo: async (address, commitment) => address.equals(held.canonical) && !own
        ? { data: planned, owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 0, rentEpoch: 0 }
        : connection.getAccountInfo(address, commitment) };
      setup.push(await createTransferCheckedWithTransferHookInstruction(resolver, source.address,
        key(route.candidate.market.mint), held.canonical, buyer, move, route.candidate.market.decimals, [], 'confirmed', TOKEN_2022_PROGRAM_ID));
      remaining -= move; if (!remaining) break;
    }
    if (remaining) throw new TradeError(409, 'INSUFFICIENT_TOKEN_BALANCE', `The wallet has insufficient ${route.candidate.market.label} for this trade.`);
  }
  const base = { chain: 'mainnet-beta', routeKind: 'hooked-orca', buyer: buyer.toBase58(),
    inputMint: route.candidate.mints[0], outputMint: route.candidate.mints.at(-1), inputRaw: route.amount.toString(),
    expectedOutputRaw: route.output.toString(), minimumOutputRaw: route.minOutput.toString(),
    hookProgram: route.hookProgram, marketMint: route.candidate.market.mint, slippageBps: 100,
    pools: route.candidate.pools, routePlan: route.publicQuote.routePlan,
    amountMode: route.publicQuote.amountMode, estimatedInputRaw: route.estimatedInput.toString(),
    accounts: Object.fromEntries([...accounts].map(([mint, account]) => [mint, account.toBase58()])) };
  if (setup.length) {
    const prepared = await simulatePacket(connection, buyer, setup, 'Wallet account setup');
    return { ...base, stage: 'setup', sourceTransfers, ...prepared.public, tx: prepared.tx,
      message: 'Prepare this wallet’s token accounts first. A swap will be freshly simulated after setup confirms.' };
  }
  const input = route.tokens[0], inputInfo = infos.get(input.address.toBase58());
  if (input.address.toBase58() !== WSOL && inputInfo.data.readBigUInt64LE(64) < BigInt(route.amount.toString())) {
    throw new TradeError(409, 'INSUFFICIENT_TOKEN_BALANCE', 'The wallet has insufficient input tokens.');
  }
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];
  if (input.address.toBase58() === WSOL) {
    const existing = inputInfo.data.readBigUInt64LE(64);
    const wrap = BigInt(route.amount.toString()) > existing ? BigInt(route.amount.toString()) - existing : 0n;
    if (wrap) instructions.push(SystemProgram.transfer({ fromPubkey: buyer, toPubkey: accounts.get(WSOL), lamports: Number(wrap) }));
    instructions.push(createSyncNativeInstruction(accounts.get(WSOL)));
  }
  if (route.candidate.kind === 'orca') instructions.push(...await swapOne(connection, route, 0, buyer, accounts));
  else if (route.candidate.kind === 'orca-two-hop') instructions.push(...await swapTwo(connection, route, buyer, accounts));
  else if (route.candidate.buying) {
    instructions.push(cpIx(route.cp, buyer, WSOL, accounts.get(WSOL), accounts.get(GGO8), route.intermediate, route.amount, true));
    instructions.push(...await swapOne(connection, route, 1, buyer, accounts));
  } else {
    instructions.push(...await swapOne(connection, route, 0, buyer, accounts));
    instructions.push(cpIx(route.cp, buyer, GGO8, accounts.get(GGO8), accounts.get(WSOL), route.intermediate, route.minOutput, false));
  }
  if (accounts.has(WSOL)) instructions.push(createCloseAccountInstruction(accounts.get(WSOL), buyer, buyer, [], TOKEN_PROGRAM_ID));
  const prepared = await simulatePacket(connection, buyer, instructions, 'Complete hooked trade');
  return { ...base, stage: 'swap', ...prepared.public, tx: prepared.tx,
    message: route.publicQuote.amountMode === 'max' ? 'Input is a maximum. Unused input stays in your wallet; WSOL is unwrapped to SOL.'
      : 'One atomic, hook-aware trade. WSOL is unwrapped to SOL after the swap.' };
}

export async function executableRoutes(connection, inputMint, outputMint, amountRaw, buyer = null) {
  const candidates = routeCandidates(inputMint, outputMint);
  if (!candidates.length) throw new TradeError(422, 'UNSUPPORTED_HOOKED_PAIR',
    'No verified direct market exists for this hooked pair. Choose SOL and one of XEEu, 5oCp, or DZVf.');
  if (inputMint === WSOL && (BigInt(amountRaw) < 100_000n || BigInt(amountRaw) > 300_000_000n)) {
    throw new TradeError(400, 'AMOUNT_RANGE', 'SOL buys must be between 0.0001 and 0.3 SOL.');
  }
  if (buyer) await requireHolder(connection, buyer, candidates[0].market);
  const quoted = await Promise.allSettled(candidates.map((candidate) => quoteRoute(connection, candidate, amountRaw)));
  const viable = quoted.filter((result) => result.status === 'fulfilled').map((result) => result.value)
    .sort((a, b) => a.output.gt(b.output) ? -1 : a.output.lt(b.output) ? 1 : 0);
  let last = quoted.find((result) => result.status === 'rejected')?.reason;
  for (const route of viable) {
    if (!buyer) return { quote: route.publicQuote, prepared: null };
    try {
      const prepared = await prepareRoute(connection, route, buyer);
      return { quote: { ...route.publicQuote, simulation: { passed: true, stage: prepared.stage },
        transaction: prepared.transaction }, prepared };
    } catch (error) { last = error; }
  }
  throw last || new TradeError(422, 'NO_EXECUTABLE_ROUTE', 'No complete route passed mainnet simulation for this wallet and amount.');
}

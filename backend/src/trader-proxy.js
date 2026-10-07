// Jupiter Ultra Terminal proxy. Standard swaps stay on Ultra; a supported
// TransferHook pair is quoted and built through a direct Orca SwapV2 adapter.
// The server never signs transactions. It only relays signed hook transactions
// whose exact messages it prepared and simulated for a wallet.
import { createHash } from 'node:crypto';
import { Wallet } from '@coral-xyz/anchor';
import { Percentage } from '@orca-so/common-sdk';
import { PriceMath, WhirlpoolContext, buildWhirlpoolClient, swapQuoteByInputToken } from '@orca-so/whirlpools-sdk';
import { TOKEN_2022_PROGRAM_ID, getTransferHook, getMint, unpackMint } from '@solana/spl-token';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { prepareDirectBuy } from './direct-buy.js';

const ULTRA = 'https://api.jup.ag/ultra/v1';
const WSOL = 'So11111111111111111111111111111111111111112';
const XEEU = 'XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo';
const HOOK = 'VwcGiFProGtfYLKsDpJuxZoYMFZpuZ1XT6MGmBd9AwU';
const CONTROLLER = '331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth';
const POOL = '9zST8JLNeJXH518mDmAQRiKfYtoG8AymytyoEK8pkdfa';
const PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const KNOWN_HOOKED = new Set([
  XEEU,
  '5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd',
  'DZVfZHdtS266p4qpTR7vFXxXbrBku18nt9Uxp4KD9bsi',
]);
const LAMPORT_MIN = 100_000n;
const LAMPORT_MAX = 300_000_000n;
const MAX_U64 = (1n << 64n) - 1n;
const ORDER_TIMEOUT_MS = 8_000;
const PREPARED_TTL_MS = 2 * 60_000;
const MINT_CACHE_MS = 30_000;

function key(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return null;
  try { return new PublicKey(value).toBase58(); } catch { return null; }
}
function amount(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)) return null;
  const n = BigInt(value);
  return n <= MAX_U64 ? n : null;
}
function one(value) { return typeof value === 'string' ? value : null; }
function messageHash(transaction) {
  return createHash('sha256').update(transaction.message.serialize()).digest('hex');
}
function limit(windowMs, perIp, globalCap) {
  const ipCalls = new Map();
  let globalTimes = [];
  return (request, response, next) => {
    const now = Date.now();
    const ip = request.ip || 'unknown';
    globalTimes = globalTimes.filter((t) => now - t < windowMs);
    const own = (ipCalls.get(ip) || []).filter((t) => now - t < windowMs);
    if (own.length >= perIp || globalTimes.length >= globalCap) {
      response.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return response.status(429).json({ error: 'Trade requests are rate limited; retry shortly.' });
    }
    own.push(now); globalTimes.push(now); ipCalls.set(ip, own);
    if (ipCalls.size > 2000) for (const [addr, times] of ipCalls) {
      if (times.at(-1) < now - windowMs) ipCalls.delete(addr);
    }
    next();
  };
}

export function mountTraderProxy(app, connection) {
  const mintHooks = new Map();
  const prepared = new Map();
  const submitted = new Map();
  const orderLimit = limit(60_000, 24, 240);
  const prepareLimit = limit(60_000, 8, 48);
  const submitLimit = limit(60_000, 6, 60);

  async function hasTransferHook(mintAddress) {
    if (KNOWN_HOOKED.has(mintAddress)) return true;
    if (mintAddress === WSOL) return false;
    const cached = mintHooks.get(mintAddress);
    if (cached && Date.now() - cached.at < MINT_CACHE_MS) return cached.hooked;
    const address = new PublicKey(mintAddress);
    const info = await connection.getAccountInfo(address, 'confirmed');
    let hooked = false;
    if (info?.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      // A malformed Token-2022 mint must fail closed, not be sent to Ultra.
      hooked = Boolean(getTransferHook(unpackMint(address, info, TOKEN_2022_PROGRAM_ID))?.programId);
    }
    mintHooks.set(mintAddress, { at: Date.now(), hooked });
    if (mintHooks.size > 1000) for (const [mint, value] of mintHooks) {
      if (Date.now() - value.at >= MINT_CACHE_MS) mintHooks.delete(mint);
    }
    return hooked;
  }

  async function hookedQuote(inputMint, outputMint, rawAmount) {
    if (rawAmount < LAMPORT_MIN || rawAmount > LAMPORT_MAX) {
      return { status: 400, body: { error: 'Direct XEEu buy amount must be 0.0001–0.3 SOL.' } };
    }
    const mint = await getMint(connection, new PublicKey(XEEU), 'confirmed', TOKEN_2022_PROGRAM_ID);
    const active = getTransferHook(mint);
    if (!active?.programId?.equals(new PublicKey(HOOK)) ||
        !active.authority?.equals(new PublicKey(CONTROLLER))) {
      throw new Error('Live XEEu hook changed');
    }
    const ctx = WhirlpoolContext.from(connection, new Wallet(Keypair.generate()), undefined, undefined, {}, PROGRAM);
    const whirlpool = await buildWhirlpoolClient(ctx).getPool(new PublicKey(POOL));
    const pool = whirlpool.getData();
    if (!pool.tokenMintA.equals(new PublicKey(WSOL)) ||
        !pool.tokenMintB.equals(new PublicKey(XEEU)) || pool.liquidity.isZero()) {
      throw new Error('Hooked Whirlpool unavailable');
    }
    const quote = await swapQuoteByInputToken(
      whirlpool, new PublicKey(WSOL), new BN(rawAmount.toString()),
      Percentage.fromFraction(1, 100), PROGRAM, ctx.fetcher,
    );
    if (quote.estimatedAmountOut.isZero() || quote.otherAmountThreshold.isZero()) {
      throw new Error('Hooked Whirlpool cannot quote the amount');
    }
    const spot = PriceMath.sqrtPriceX64ToPrice(pool.sqrtPrice, 9, mint.decimals);
    const ideal = spot.mul(new Decimal(rawAmount.toString()).div(1e9))
      .mul(new Decimal(10).pow(mint.decimals));
    const impact = Decimal.max(0, new Decimal(1)
      .minus(new Decimal(quote.estimatedAmountOut.toString()).div(ideal)));
    return { status: 200, body: {
      routeKind: 'hooked-orca',
      inputMint, outputMint,
      inAmount: rawAmount.toString(),
      outAmount: quote.estimatedAmountOut.toString(),
      otherAmountThreshold: quote.otherAmountThreshold.toString(),
      priceImpactPct: impact.toFixed(8),
      routePlan: [{ percent: 100, swapInfo: {
        ammKey: POOL, label: 'Orca Whirlpools · THOOOK', inputMint, outputMint,
        inAmount: rawAmount.toString(), outAmount: quote.estimatedAmountOut.toString(),
      } }],
      contextSlot: await connection.getSlot('confirmed'),
      transaction: null,
      swapType: 'thoook-direct',
      gasless: false,
      requestId: `thoook-${Date.now()}`,
      slippageBps: 100,
      feeBps: 0,
      router: 'thoook',
      platformFee: { feeBps: 0 },
      prioritizationFeePayer: null,
      rentFeePayer: null,
      signatureFeePayer: null,
    } };
  }

  function parseOrder(query) {
    const inputMint = key(one(query.inputMint));
    const outputMint = key(one(query.outputMint));
    const rawAmount = amount(one(query.amount));
    const taker = query.taker == null ? null : key(one(query.taker));
    const swapMode = query.swapMode == null ? 'ExactIn' : one(query.swapMode);
    if (!inputMint || !outputMint || inputMint === outputMint || !rawAmount ||
        (query.taker != null && !taker) || !['ExactIn', 'ExactOut'].includes(swapMode)) return null;
    const params = new URLSearchParams({ inputMint, outputMint, amount: rawAmount.toString(), swapMode });
    if (taker) params.set('taker', taker);
    for (const field of ['referralAccount', 'referralFee', 'excludeDexes', 'excludeRouters']) {
      const value = one(query[field]);
      if (value && value.length <= 200) params.set(field, value);
    }
    return { inputMint, outputMint, rawAmount, taker, swapMode, params };
  }

  app.get('/api/trader/order', orderLimit, async (request, response) => {
    const parsed = parseOrder(request.query);
    if (!parsed) return response.status(400).json({ error: 'Invalid trade pair, amount, wallet, or swap mode.' });
    response.set('Cache-Control', 'no-store');
    try {
      const { inputMint, outputMint, rawAmount, swapMode, params } = parsed;
      const hooked = await Promise.all([hasTransferHook(inputMint), hasTransferHook(outputMint)]);
      if (hooked.some(Boolean)) {
        if (inputMint !== WSOL || outputMint !== XEEU || swapMode !== 'ExactIn') {
          return response.status(422).json({ error: 'Hooked pair needs a supported direct Orca market. This trade was not sent to Jupiter.' });
        }
        const quoted = await hookedQuote(inputMint, outputMint, rawAmount);
        return response.status(quoted.status).json(quoted.body);
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ORDER_TIMEOUT_MS);
      let upstream;
      try {
        upstream = await fetch(`${ULTRA}/order?${params}`, {
          signal: controller.signal,
          headers: { 'x-client-platform': 'thoook.terminal',
            ...(process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {}) },
        });
      } finally { clearTimeout(timeout); }
      const json = await upstream.json();
      if (!upstream.ok) return response.status(upstream.status).json({ error: json.error || json.message || 'Jupiter quote failed.' });
      return response.json({ ...json, routeKind: 'jupiter-ultra' });
    } catch (error) {
      console.error('[trader] order failed:', error.message);
      return response.status(503).json({ error: 'Trade quote unavailable; retry shortly.' });
    }
  });

  app.post('/api/trader/prepare', prepareLimit, async (request, response) => {
    const { inputMint, outputMint, amount: raw, taker, swapMode } = request.body || {};
    if (inputMint !== WSOL || outputMint !== XEEU || swapMode !== 'ExactIn') {
      return response.status(422).json({ error: 'Only the direct WSOL → XEEu hooked market is executable here.' });
    }
    const rawAmount = amount(raw);
    if (!rawAmount || !key(taker)) return response.status(400).json({ error: 'Invalid wallet or amount.' });
    try {
      const preparedResult = await prepareDirectBuy(connection, { buyer: taker, amountLamports: rawAmount.toString() });
      if (preparedResult.status !== 200) return response.status(preparedResult.status).json(preparedResult.body);
      const transaction = VersionedTransaction.deserialize(Buffer.from(preparedResult.body.transaction, 'base64'));
      const id = messageHash(transaction);
      prepared.set(id, { at: Date.now(), buyer: taker, stage: preparedResult.body.stage,
        inputRaw: rawAmount.toString() });
      if (prepared.size > 1000) for (const [hash, item] of prepared) {
        if (Date.now() - item.at > PREPARED_TTL_MS) prepared.delete(hash);
      }
      response.set('Cache-Control', 'no-store');
      return response.json({ ...preparedResult.body, routeKind: 'hooked-orca' });
    } catch (error) {
      console.error('[trader] prepare failed:', error.message);
      return response.status(503).json({ error: 'Hook-aware trade preparation failed; retry shortly.' });
    }
  });

  app.post('/api/trader/submit', submitLimit, async (request, response) => {
    const encoded = request.body?.signedTransaction;
    if (typeof encoded !== 'string' || encoded.length > 4000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      return response.status(400).json({ error: 'Invalid signed transaction.' });
    }
    response.set('Cache-Control', 'no-store');
    try {
      const transaction = VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'));
      const id = messageHash(transaction);
      const record = prepared.get(id);
      if (!record || Date.now() - record.at > PREPARED_TTL_MS) {
        return response.status(409).json({ error: 'Transaction was not prepared here or has expired. Refresh quote.' });
      }
      if (!transaction.message.staticAccountKeys[0]?.equals(new PublicKey(record.buyer))) {
        return response.status(400).json({ error: 'Fee payer changed after preparation.' });
      }
      const simulation = await connection.simulateTransaction(transaction, {
        sigVerify: true, commitment: 'confirmed',
      });
      if (simulation.value.err) return response.status(409).json({ error: 'Signed trade no longer simulates; refresh quote.' });
      const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3,
      });
      submitted.set(signature, { ...record, at: Date.now() });
      if (submitted.size > 1000) for (const [sig, item] of submitted) {
        if (Date.now() - item.at > 60 * 60_000) submitted.delete(sig);
      }
      prepared.delete(id);
      return response.json({ signature, stage: record.stage, routeKind: 'hooked-orca' });
    } catch (error) {
      console.error('[trader] submit failed:', error.message);
      return response.status(503).json({ error: 'Signed trade could not be sent; retry with a fresh quote.' });
    }
  });

  app.get('/api/trader/status/:signature', orderLimit, async (request, response) => {
    const { signature } = request.params;
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
      return response.status(400).json({ error: 'Invalid signature.' });
    }
    response.set('Cache-Control', 'no-store');
    try {
      const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      const record = submitted.get(signature);
      const confirmed = Boolean(status && !status.err &&
        ['confirmed', 'finalized'].includes(status.confirmationStatus));
      let outputAmountResult = null;
      if (confirmed && record?.stage === 'swap') {
        const tx = await connection.getTransaction(signature, {
          commitment: 'confirmed', maxSupportedTransactionVersion: 0,
        });
        if (tx?.meta && !tx.meta.err) {
          const total = (balances) => (balances || []).filter((entry) =>
            entry.mint === XEEU && entry.owner === record.buyer,
          ).reduce((sum, entry) => sum + BigInt(entry.uiTokenAmount.amount), 0n);
          outputAmountResult = (total(tx.meta.postTokenBalances) -
            total(tx.meta.preTokenBalances)).toString();
        }
      }
      return response.json({ signature, chain: 'mainnet-beta', confirmed,
        confirmationStatus: status?.confirmationStatus || null, err: status?.err || null,
        routeKind: record ? 'hooked-orca' : null,
        stage: record?.stage || null,
        inputAmountResult: confirmed && record?.stage === 'swap' ? record.inputRaw : null,
        outputAmountResult,
      });
    } catch (error) {
      console.error('[trader] status failed:', error.message);
      return response.status(503).json({ error: 'Trade status unavailable; retry shortly.' });
    }
  });

  app.post('/api/trader/execute', submitLimit, async (request, response) => {
    const { signedTransaction, requestId } = request.body || {};
    if (typeof signedTransaction !== 'string' || signedTransaction.length > 4000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(signedTransaction) ||
        typeof requestId !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(requestId) ||
        requestId.startsWith('thoook-')) {
      return response.status(400).json({ error: 'Invalid Jupiter execution request.' });
    }
    response.set('Cache-Control', 'no-store');
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ORDER_TIMEOUT_MS);
      let upstream;
      try {
        upstream = await fetch(`${ULTRA}/execute`, {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'x-client-platform': 'thoook.terminal',
            ...(process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {}) },
          body: JSON.stringify({ signedTransaction, requestId }),
        });
      } finally { clearTimeout(timeout); }
      const json = await upstream.json();
      return response.status(upstream.status).json(json);
    } catch (error) {
      console.error('[trader] Jupiter execute failed:', error.message);
      return response.status(503).json({ error: 'Jupiter execution unavailable; check your wallet before retrying.' });
    }
  });
}

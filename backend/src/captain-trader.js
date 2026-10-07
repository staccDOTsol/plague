import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getTransferHook, unpackMint } from '@solana/spl-token';
import { executableRoutes } from './hooked-router.js';
import { createPreparationReceipts, decodeSignedTransaction, messageHash, verifyBuyerSigned } from './prepared-transactions.js';
import { MARKETS, KNOWN_HOOKED, WSOL } from './router-markets.js';
import { walletBalances, mintHoldings } from './wallet-holdings.js';
import { tradeFailure, TradeError } from './trade-errors.js';
import { rateLimit } from './rate-limit.js';
import { mountLiquidity } from './liquidity.js';
import { mountAuctions, readAuctions } from './auction-market.js';

const ULTRA = 'https://api.jup.ag/ultra/v1';
const address = (value) => {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return null;
  try { return new PublicKey(value); } catch { return null; }
};
const amount = (value) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) &&
  BigInt(value) <= (1n << 64n) - 1n ? value : null;
const respondError = (response, error) => {
  const failure = tradeFailure(error); response.status(failure.status).json(failure.body);
};

async function upstream(path, options = {}) {
  const response = await fetch(`${ULTRA}${path}`, {
    ...options, signal: AbortSignal.timeout(12_000),
    headers: { 'x-client-platform': 'captainhook.terminal',
      ...(process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {}), ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new TradeError(response.status, 'JUPITER_ERROR', data.error || data.message || 'Jupiter Ultra request failed.');
  return data;
}

export function mountCaptainTrader(app, connection) {
  const receipts = createPreparationReceipts();
  const readLimit = rateLimit({ perIp: 120, global: 900 });
  const orderLimit = rateLimit({ perIp: 36, global: 300 });
  const prepareLimit = rateLimit({ perIp: 12, global: 90 });
  const submitLimit = rateLimit({ perIp: 8, global: 90 });
  const cache = new Map();
  async function hooked(mint) {
    if (KNOWN_HOOKED.has(mint)) return true;
    if (mint === WSOL) return false;
    const prior = cache.get(mint);
    if (prior && Date.now() - prior.at < 10_000) return prior.hooked;
    const account = await connection.getAccountInfo(address(mint), 'confirmed');
    let result = false;
    if (account?.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      const hook = getTransferHook(unpackMint(address(mint), account, TOKEN_2022_PROGRAM_ID));
      result = Boolean(hook?.programId && !hook.programId.equals(PublicKey.default));
    }
    cache.set(mint, { at: Date.now(), hooked: result });
    if (cache.size > 1000) for (const [key, entry] of cache) if (Date.now() - entry.at > 10_000) cache.delete(key);
    return result;
  }
  function publicPrepared(prepared) {
    const { tx, ...body } = prepared;
    const preparationToken = receipts.issue(tx, { engine: 'hooked-orca', buyer: body.buyer,
      stage: body.stage, inputMint: body.inputMint, outputMint: body.outputMint,
      inputRaw: body.inputRaw, minimumOutputRaw: body.minimumOutputRaw, marketMint: body.marketMint,
      accounts: body.accounts });
    return { ...body, preparationToken };
  }
  async function prepare(inputMint, outputMint, raw, taker) {
    const result = await executableRoutes(connection, inputMint, outputMint, raw, taker);
    const prepared = result.prepared ? publicPrepared(result.prepared) : null;
    return { ...result.quote, prepared };
  }

  app.get('/api/trader/order', orderLimit, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const input = address(request.query.inputMint), output = address(request.query.outputMint);
    const raw = amount(request.query.amount);
    const taker = request.query.taker == null ? null : address(request.query.taker);
    const swapMode = request.query.swapMode || 'ExactIn';
    if (!input || !output || input.equals(output) || !raw || (request.query.taker != null && !taker)) {
      return response.status(400).json({ code: 'INVALID_ORDER', error: 'Choose valid mints, a positive amount, and a valid wallet.' });
    }
    try {
      const mints = [input.toBase58(), output.toBase58()];
      if ((await Promise.all(mints.map(hooked))).some(Boolean)) {
        if (swapMode !== 'ExactIn') throw new TradeError(422, 'EXACT_INPUT_REQUIRED', 'Hooked routes use exact-input or capped-input amounts. Enter the amount to spend.');
        return response.json(await prepare(...mints, raw, taker));
      }
      const query = new URLSearchParams({ inputMint: mints[0], outputMint: mints[1], amount: raw, swapMode });
      if (taker) query.set('taker', taker.toBase58());
      for (const field of ['referralAccount', 'referralFee', 'excludeDexes', 'excludeRouters']) {
        if (typeof request.query[field] === 'string' && request.query[field].length <= 200) query.set(field, request.query[field]);
      }
      response.json({ ...await upstream(`/order?${query}`), routeKind: 'jupiter-ultra' });
    } catch (error) { respondError(response, error); }
  });

  app.post('/api/trader/prepare', prepareLimit, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const { inputMint, outputMint, amount: raw, taker, swapMode } = request.body || {};
    const buyer = address(taker);
    if (!address(inputMint) || !address(outputMint) || !amount(raw) || !buyer || swapMode !== 'ExactIn') {
      return response.status(400).json({ code: 'INVALID_PREPARATION', error: 'Invalid trade mints, amount, mode, or wallet.' });
    }
    try { response.json((await prepare(inputMint, outputMint, raw, buyer)).prepared); }
    catch (error) { respondError(response, error); }
  });

  app.post('/api/trader/submit', submitLimit, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      const record = receipts.read(request.body?.preparationToken);
      if (record.engine !== 'hooked-orca') throw new TradeError(400, 'WRONG_ENGINE', 'This receipt is not for a trade.');
      const tx = decodeSignedTransaction(request.body?.signedTransaction); verifyBuyerSigned(tx, record);
      const simulated = await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
      if (simulated.value.err) {
        throw new TradeError(409, 'SIGNED_SIMULATION_FAILED', simulated.value.logs?.some((line) => line.includes('existing holders only'))
          ? 'The holder gate rejected the signed trade. This wallet must already hold the mint.'
          : 'The signed trade no longer passes simulation. Refresh the quote; nothing was submitted.');
      }
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
      response.json({ signature, stage: record.stage, routeKind: 'hooked-orca' });
    } catch (error) { respondError(response, error); }
  });

  app.get('/api/trader/status/:signature', readLimit, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(request.params.signature)) return response.status(400).json({ error: 'Invalid transaction signature.' });
    try {
      const signature = request.params.signature;
      const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      const confirmed = Boolean(status && !status.err && ['confirmed', 'finalized'].includes(status.confirmationStatus));
      const record = request.query.receipt ? receipts.read(request.query.receipt, true) : null;
      let inputAmountResult = null, outputAmountResult = null;
      if (confirmed && record?.stage === 'swap') {
        const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (tx?.meta && !tx.meta.err && messageHash({ message: tx.transaction.message }) === record.hash) {
          const sum = (balances, mint) => (balances || []).filter((entry) => entry.mint === mint && entry.owner === record.buyer)
            .reduce((total, entry) => total + BigInt(entry.uiTokenAmount.amount), 0n);
          const pre = tx.meta.preTokenBalances, post = tx.meta.postTokenBalances;
          const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
          const all = [...Array(keys.length)].map((_, i) => keys.get(i).toBase58());
          const wsolIndex = all.indexOf(record.accounts[WSOL]);
          const priorWsolLamports = BigInt(wsolIndex >= 0 ? tx.meta.preBalances[wsolIndex] : 0);
          const before = BigInt(tx.meta.preBalances[0]), after = BigInt(tx.meta.postBalances[0]), fee = BigInt(tx.meta.fee);
          inputAmountResult = (record.inputMint === WSOL ? before - after - fee + priorWsolLamports
            : sum(pre, record.inputMint) - sum(post, record.inputMint)).toString();
          outputAmountResult = (record.outputMint === WSOL ? after - before + fee - priorWsolLamports
            : sum(post, record.outputMint) - sum(pre, record.outputMint)).toString();
        }
      }
      response.json({ signature, chain: 'mainnet-beta', confirmed, err: status?.err || null,
        confirmationStatus: status?.confirmationStatus || null, stage: record?.stage || null,
        inputAmountResult, outputAmountResult });
    } catch (error) { respondError(response, error); }
  });

  app.post('/api/trader/execute', submitLimit, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const { signedTransaction, requestId } = request.body || {};
    if (typeof signedTransaction !== 'string' || signedTransaction.length > 4000 || typeof requestId !== 'string' ||
      !/^[A-Za-z0-9-]{8,100}$/.test(requestId) || requestId.startsWith('captainhook-')) {
      return response.status(400).json({ error: 'Invalid Jupiter execution request.' });
    }
    try { response.json(await upstream('/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedTransaction, requestId }) })); }
    catch (error) { respondError(response, error); }
  });

  app.get('/api/trader/balances/:wallet', readLimit, async (request, response) => {
    const owner = address(request.params.wallet);
    if (!owner) return response.status(400).json({ error: 'Invalid wallet.' });
    response.set('Cache-Control', 'no-store');
    try { response.json(await walletBalances(connection, owner)); } catch (error) { respondError(response, error); }
  });

  let marketCache = null, marketPending = null;
  app.get('/api/trader/markets', readLimit, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      if (!marketCache || Date.now() - marketCache.at > 5000) {
        if (!marketPending) marketPending = (async () => {
          const infos = await connection.getMultipleAccountsInfo(MARKETS.map((market) => address(market.mint)), 'confirmed');
          const auctions = await readAuctions(connection);
          const markets = MARKETS.map((market, i) => {
            const mint = unpackMint(address(market.mint), infos[i], TOKEN_2022_PROGRAM_ID);
            const hook = getTransferHook(mint);
            return { ...market, decimals: mint.decimals, hookProgram: hook?.programId?.toBase58() || null,
              hookAuthority: hook?.authority?.toBase58() || null, auction: auctions.find((auction) => auction.mint === market.mint) };
          });
          const data = { brand: 'Captain Hook', chain: 'mainnet-beta', defaultMint: MARKETS[0].mint,
            checkedAt: new Date().toISOString(), markets };
          marketCache = { at: Date.now(), data }; return data;
        })().finally(() => { marketPending = null; });
        await marketPending;
      }
      const owner = request.query.wallet ? address(request.query.wallet) : null;
      if (request.query.wallet && !owner) return response.status(400).json({ error: 'Invalid wallet.' });
      const holdings = owner ? await Promise.all(MARKETS.map((market) => mintHoldings(connection, owner, address(market.mint)))) : null;
      response.json({ ...marketCache.data, markets: marketCache.data.markets.map((market, i) => ({ ...market,
        heldRaw: holdings ? holdings[i].total.toString() : null, eligible: holdings ? holdings[i].total > 0n : null })) });
    } catch (error) { respondError(response, error); }
  });

  mountAuctions(app, connection, receipts, { readLimit, prepareLimit, submitLimit });
  mountLiquidity(app, connection, receipts, { readLimit, prepareLimit, submitLimit });
}

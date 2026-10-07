// English hook auctions. Bidders sign their own escrowed bids; the backend only
// relays them. After the clock runs out, the literal 331n authority settles the
// round (payment, hook-pointer change, and a checked-transfer proof through the
// winning hook) or, if that proof cannot pass, refunds the leader and reopens.
import { Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, addExtraAccountMetasForExecute, createTransferCheckedInstruction, getTransferHook, unpackMint,
} from '@solana/spl-token';
import { MARKETS, MARKET_BY_MINT, HOOK, CONTROLLER } from './router-markets.js';
import { mintHoldings, requireHolder } from './wallet-holdings.js';
import { simulatePacket } from './hooked-router.js';
import { decodeSignedTransaction, verifyBuyerSigned } from './prepared-transactions.js';
import { TradeError, tradeFailure } from './trade-errors.js';

const PROGRAM = new PublicKey(HOOK), ADMIN = new PublicKey(CONTROLLER);
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const PROOF_RECIPIENT = new PublicKey('99VXriv7RXJSypeJDBQtGRsak1n5o2NBzbtMXhHW2RNG');
const EXECUTE = Buffer.from([105, 37, 101, 197, 75, 251, 102, 26]);
const MAGIC = 'HKAUCT02', SIZE = 312, BPS = 10_000n;
const VOID_GRACE_SECONDS = Number(process.env.AUCTION_VOID_AFTER_SECONDS || 600);
const key = (value) => { try { return typeof value === 'string' ? new PublicKey(value) : null; } catch { return null; } };
const pda = (seed, mint, program = PROGRAM) => PublicKey.findProgramAddressSync([Buffer.from(seed), mint.toBuffer()], program)[0];
const u64 = (value) => { const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt(value)); return data; };
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const fail = (response, error) => { const result = tradeFailure(error); response.status(result.status).json(result.body); };
const optional = (buffer) => { const value = new PublicKey(buffer); return value.equals(PublicKey.default) ? null : value.toBase58(); };
const lamports = (value) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= (1n << 64n) - 1n;

export function minimumNextBid(highBidLamports, minBidLamports, incrementBps) {
  const bid = BigInt(highBidLamports);
  if (bid === 0n) return BigInt(minBidLamports);
  const raise = (bid * BigInt(incrementBps) + BPS - 1n) / BPS;
  return bid + (raise > 0n ? raise : 1n);
}

export async function readAuctions(connection) {
  const addresses = MARKETS.map((market) => pda('auction', key(market.mint)));
  const infos = await connection.getMultipleAccountsInfo([...addresses, SYSVAR_CLOCK_PUBKEY], 'confirmed');
  const clock = infos.at(-1);
  if (!clock || clock.data.length < 40) throw new TradeError(503, 'CLOCK_UNAVAILABLE', 'The mainnet clock is unavailable.');
  const now = clock.data.readBigInt64LE(32);
  return MARKETS.map((market, i) => {
    const info = infos[i], auction = addresses[i].toBase58();
    if (!info?.owner.equals(PROGRAM) || info.data.length !== SIZE || info.data.subarray(0, 8).toString() !== MAGIC) {
      return { mint: market.mint, auction, ready: false, error: 'Auction account unavailable.' };
    }
    const data = info.data;
    if (new PublicKey(data.subarray(8, 40)).toBase58() !== market.mint ||
        !new PublicKey(data.subarray(40, 72)).equals(ADMIN)) throw new TradeError(503, 'AUCTION_CHANGED', 'An auction account has unexpected terms.');
    const minBid = data.readBigUInt64LE(104), incrementBps = data.readBigUInt64LE(112);
    const duration = data.readBigUInt64LE(120), extension = data.readBigUInt64LE(128);
    const ends = data.readBigInt64LE(152), bid = data.readBigUInt64LE(192);
    const phase = bid === 0n ? 'open' : now >= ends ? 'ended' : 'live';
    return { mint: market.mint, auction, ready: true, round: data.readBigUInt64LE(136).toString(),
      minBidLamports: minBid.toString(), incrementBps: Number(incrementBps), durationSeconds: Number(duration),
      extensionSeconds: Number(extension), startedAt: Number(data.readBigInt64LE(144)), endsAt: Number(ends),
      serverUnixSeconds: Number(now), phase, highBidLamports: bid.toString(), highBidder: optional(data.subarray(160, 192)),
      proposedHook: optional(data.subarray(200, 232)), minNextBidLamports: minimumNextBid(bid, minBid, incrementBps).toString(),
      paymentRecipient: new PublicKey(data.subarray(72, 104)).toBase58(), retainedAuthority: CONTROLLER,
      lastWinner: optional(data.subarray(232, 264)), lastPaidLamports: data.readBigUInt64LE(264).toString(),
      lastWinningHook: optional(data.subarray(272, 304)), lastWonAt: Number(data.readBigInt64LE(304)) };
  });
}

async function runnable(connection, program) {
  const info = await connection.getAccountInfo(program, 'confirmed');
  if (!info?.executable) return false;
  if (!info.owner.equals(LOADER)) return true;
  if (info.data.length < 36 || info.data.readUInt32LE(0) !== 2) return false;
  const data = await connection.getAccountInfo(new PublicKey(info.data.subarray(4, 36)), 'confirmed');
  return Boolean(data?.owner.equals(LOADER) && data.data.length > 45 && data.data.readUInt32LE(0) === 3);
}

async function requireWiredHook(connection, mint, proposed) {
  if (!await runnable(connection, proposed)) throw new TradeError(422, 'HOOK_NOT_RUNNABLE', 'The proposed hook must be a runnable mainnet program.');
  const eaml = pda('extra-account-metas', mint, proposed);
  const info = await connection.getAccountInfo(eaml, 'confirmed');
  if (!info?.owner.equals(proposed) || info.data.length < 16 || !info.data.subarray(0, 8).equals(EXECUTE)) {
    throw new TradeError(422, 'EAML_REQUIRED', 'Wire this program’s ExtraAccountMetaList for the selected mint before bidding.');
  }
  return eaml;
}

export async function prepareBid(connection, body) {
  const market = MARKET_BY_MINT.get(body?.mint), bidder = key(body?.buyer ?? body?.bidder), proposed = key(body?.programId);
  if (!market || !bidder || !proposed || !PublicKey.isOnCurve(bidder.toBuffer())) {
    throw new TradeError(400, 'INVALID_AUCTION', 'Select a controlled mint, connected wallet, and deployed hook program.');
  }
  if (!lamports(body.bidLamports)) throw new TradeError(400, 'INVALID_BID', 'Enter a bid in lamports.');
  const mint = key(market.mint);
  const held = await requireHolder(connection, bidder, market);
  const holding = held.accounts.find((account) => account.amount > 0n);
  const auction = (await readAuctions(connection)).find((auction) => auction.mint === market.mint);
  if (!auction?.ready) throw new TradeError(503, 'AUCTION_UNAVAILABLE', 'This auction cannot currently be verified on-chain.');
  if (body.round != null && body.round !== auction.round) throw new TradeError(409, 'ROUND_CHANGED', 'That round has finished. Refresh the live round.');
  if (auction.phase === 'ended') throw new TradeError(409, 'ROUND_ENDED', 'Bidding closed for this round; it is being settled. The next round opens right after.');
  if (BigInt(body.bidLamports) < BigInt(auction.minNextBidLamports)) {
    throw new TradeError(409, 'BID_TOO_LOW', `Bids must be at least ${auction.minNextBidLamports} lamports right now. Refresh and raise your bid.`);
  }
  const mintAccount = await connection.getAccountInfo(mint, 'confirmed');
  if (!getTransferHook(unpackMint(mint, mintAccount, TOKEN_2022_PROGRAM_ID))?.authority?.equals(ADMIN)) {
    throw new TradeError(409, 'AUTHORITY_CHANGED', 'The retained mint hook authority changed.');
  }
  const eaml = await requireWiredHook(connection, mint, proposed);
  const previous = auction.highBidder ? new PublicKey(auction.highBidder) : bidder;
  const bid = { programId: PROGRAM, data: Buffer.concat([Buffer.from([7]), u64(auction.round), u64(body.bidLamports), proposed.toBuffer()]),
    keys: [meta(bidder, true, true), meta(mint), meta(pda('config', mint)), meta(key(auction.auction), true), meta(previous, true),
      meta(proposed), meta(eaml), meta(SystemProgram.programId), meta(holding.address)] };
  const prepared = await simulatePacket(connection, bidder, [bid], 'Escrowed auction bid');
  return { ...prepared, body: { ...prepared.public, chain: 'mainnet-beta', engine: 'auction', stage: 'bid',
    buyer: bidder.toBase58(), mint: market.mint, round: auction.round, bidLamports: body.bidLamports,
    minNextBidLamports: auction.minNextBidLamports, previousBidder: previous.toBase58(), previousBidLamports: auction.highBidLamports,
    endsAt: auction.endsAt, durationSeconds: auction.durationSeconds, extensionSeconds: auction.extensionSeconds,
    paymentRecipient: auction.paymentRecipient, retainedAuthority: CONTROLLER, programId: proposed.toBase58(),
    eaml: eaml.toBase58(), holding: holding.address.toBase58(),
    message: auction.highBidder
      ? 'Your SOL is escrowed on-chain and the current leader is refunded in the same instruction. If you are outbid, you are refunded automatically.'
      : 'The first bid starts the round clock. Your SOL is escrowed on-chain and refunded automatically if you are outbid.' } };
}

async function proofDestination(connection, mint, winner) {
  const held = await mintHoldings(connection, winner, mint);
  const own = held.accounts.find((account) => account.amount > 0n);
  if (own) return own.address;
  const fallback = await mintHoldings(connection, PROOF_RECIPIENT, mint);
  const account = fallback.accounts.find((account) => account.amount > 0n);
  if (!account) throw new TradeError(503, 'PROOF_ACCOUNT_UNAVAILABLE', 'No existing-holder proof destination is available.');
  return account.address;
}

export function createSettler(connection, coSigner) {
  const busy = new Set();
  async function send(instructions, label) {
    const authority = coSigner();
    const latest = await connection.getLatestBlockhash('confirmed');
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: authority.publicKey, recentBlockhash: latest.blockhash, instructions }).compileToV0Message());
    tx.sign([authority]);
    const simulation = await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
    if (simulation.value.err) return { ok: false, label, logs: simulation.value.logs || [], err: simulation.value.err };
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    await connection.confirmTransaction({ signature, ...latest }, 'confirmed').catch(() => {});
    return { ok: true, label, signature };
  }
  async function settle(market, auction) {
    const mint = key(market.mint), winner = new PublicKey(auction.highBidder), hook = new PublicKey(auction.proposedHook);
    const eaml = pda('extra-account-metas', mint, hook);
    const settleIx = { programId: PROGRAM, data: Buffer.concat([Buffer.from([8]), u64(auction.round)]),
      keys: [meta(ADMIN, false, true), meta(mint, true), meta(pda('config', mint)), meta(key(auction.auction), true),
        meta(key(auction.paymentRecipient), true), meta(hook), meta(eaml), meta(TOKEN_2022_PROGRAM_ID), meta(SystemProgram.programId)] };
    const operator = await mintHoldings(connection, ADMIN, mint);
    const source = operator.accounts.find((account) => account.amount > 0n);
    if (!source) throw new TradeError(503, 'PROOF_RESERVE_EMPTY', 'The operator has no token balance to verify the winning hook.');
    const mintAccount = await connection.getAccountInfo(mint, 'confirmed');
    const decimals = unpackMint(mint, mintAccount, TOKEN_2022_PROGRAM_ID).decimals;
    const destination = await proofDestination(connection, mint, winner);
    const proof = createTransferCheckedInstruction(source.address, mint, destination, ADMIN, 1n, decimals, [], TOKEN_2022_PROGRAM_ID);
    await addExtraAccountMetasForExecute(connection, proof, hook, source.address, mint, destination, ADMIN, 1n, 'confirmed');
    return send([settleIx, proof], 'settle');
  }
  async function voidRound(market, auction) {
    const mint = key(market.mint);
    const ix = { programId: PROGRAM, data: Buffer.concat([Buffer.from([9]), u64(auction.round)]),
      keys: [meta(ADMIN, false, true), meta(mint), meta(pda('config', mint)), meta(key(auction.auction), true), meta(new PublicKey(auction.highBidder), true)] };
    return send([ix], 'void');
  }
  async function run(market) {
    if (busy.has(market.mint)) return { mint: market.mint, action: 'busy' };
    busy.add(market.mint);
    try {
      const auction = (await readAuctions(connection)).find((auction) => auction.mint === market.mint);
      if (!auction?.ready) return { mint: market.mint, action: 'unavailable' };
      if (auction.phase !== 'ended') return { mint: market.mint, action: 'waiting', phase: auction.phase, endsAt: auction.endsAt, round: auction.round };
      const settled = await settle(market, auction);
      if (settled.ok) return { mint: market.mint, action: 'settled', round: auction.round, signature: settled.signature, winner: auction.highBidder, hook: auction.proposedHook };
      const overdue = auction.serverUnixSeconds - auction.endsAt;
      if (overdue >= VOID_GRACE_SECONDS) {
        const voided = await voidRound(market, auction);
        return { mint: market.mint, action: voided.ok ? 'voided' : 'void-failed', round: auction.round, signature: voided.signature || null,
          refunded: auction.highBidder, reason: 'The winning hook could not pass the checked-transfer proof.', logs: voided.logs?.slice(-6) };
      }
      return { mint: market.mint, action: 'proof-failed', round: auction.round, retryUntil: auction.endsAt + VOID_GRACE_SECONDS, logs: settled.logs.slice(-6) };
    } catch (error) {
      return { mint: market.mint, action: 'error', error: error.message };
    } finally { busy.delete(market.mint); }
  }
  return { run, runAll: () => Promise.all(MARKETS.map(run)) };
}

export function mountAuctions(app, connection, receipts, limits) {
  let authority = null;
  const coSigner = () => {
    if (authority) return authority;
    if (!process.env.AUCTION_AUTHORITY_SECRET) throw new TradeError(503, 'COSIGNER_UNAVAILABLE', 'The auction authority settler is temporarily unavailable.');
    authority = Keypair.fromSecretKey(Buffer.from(process.env.AUCTION_AUTHORITY_SECRET, 'base64'));
    if (!authority.publicKey.equals(ADMIN)) throw new Error('Auction authority secret identity mismatch');
    return authority;
  };
  const settler = createSettler(connection, coSigner);
  if (process.env.AUCTION_AUTHORITY_SECRET && process.env.AUCTION_SETTLER !== '0') {
    const tick = () => settler.runAll().then((results) => {
      for (const result of results) if (!['waiting', 'busy', 'unavailable'].includes(result.action)) console.log('[auction-settler]', JSON.stringify(result));
    }).catch((error) => console.error('[auction-settler]', error.message));
    setTimeout(tick, 5_000);
    setInterval(tick, Number(process.env.AUCTION_SETTLER_MS || 20_000)).unref();
  }
  app.get('/api/trader/auctions', limits.readLimit, async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    try { response.json({ chain: 'mainnet-beta', checkedAt: new Date().toISOString(), auctions: await readAuctions(connection) }); }
    catch (error) { fail(response, error); }
  });
  app.post('/api/trader/auction/prepare', limits.prepareLimit, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      const result = await prepareBid(connection, request.body);
      const preparationToken = receipts.issue(result.tx, { engine: 'auction', stage: 'bid', buyer: result.body.buyer,
        mint: result.body.mint, round: result.body.round, programId: result.body.programId, bidLamports: result.body.bidLamports });
      response.json({ ...result.body, preparationToken });
    } catch (error) { fail(response, error); }
  });
  app.post('/api/trader/auction/submit', limits.submitLimit, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      const record = receipts.read(request.body?.preparationToken);
      if (record.engine !== 'auction') throw new TradeError(400, 'WRONG_ENGINE', 'This preparation receipt is not for an auction bid.');
      const tx = decodeSignedTransaction(request.body?.signedTransaction);
      verifyBuyerSigned(tx, record);
      const simulation = await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
      if (simulation.value.err) {
        const logs = simulation.value.logs || [];
        if (logs.some((line) => line.includes('round is over'))) throw new TradeError(409, 'ROUND_CHANGED', 'That round finished. Refresh for the live round.');
        if (logs.some((line) => line.includes('bidding closed'))) throw new TradeError(409, 'ROUND_ENDED', 'Bidding closed for this round. The next round opens after settlement.');
        if (logs.some((line) => line.includes('below the minimum raise'))) throw new TradeError(409, 'BID_TOO_LOW', 'Someone outbid you first. Refresh and raise your bid.');
        throw new TradeError(409, 'BID_SIMULATION_FAILED', 'The signed bid no longer executes. Refresh the auction and try again; nothing was submitted.');
      }
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
      response.json({ signature, stage: 'bid', round: record.round, bidLamports: record.bidLamports, programId: record.programId });
    } catch (error) { fail(response, error); }
  });
  // Anyone may ask for an ended round to be settled now instead of waiting for the loop.
  app.post('/api/trader/auction/settle', limits.prepareLimit, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      const market = MARKET_BY_MINT.get(request.body?.mint);
      if (!market) throw new TradeError(400, 'INVALID_AUCTION', 'Select a controlled mint.');
      coSigner();
      response.json(await settler.run(market));
    } catch (error) { fail(response, error); }
  });
}

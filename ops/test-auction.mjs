// Real SBF execution tests for the English hook auction: escrowed bids, refunds
// on outbid, anti-snipe extension, authority settlement, and the void refund.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FailedTransactionMetadata } from 'litesvm';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getTransferHook, unpackMint } from '@solana/spl-token';
import { fixture, snapshots } from './test-holder-gate.mjs';

const HOOK = new PublicKey('VwcGiFProGtfYLKsDpJuxZoYMFZpuZ1XT6MGmBd9AwU');
const MIN_BID = 10_000_000n, INCREMENT_BPS = 1000n, DURATION = 1800n, EXTENSION = 300n;
const u64 = (value) => { const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt(value)); return data; };
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const failed = (result) => result instanceof FailedTransactionMetadata;

function auctionFixture({ legacyFirst = false } = {}) {
  const f = fixture(snapshots[0]); f.migrate();
  const address = PublicKey.findProgramAddressSync([Buffer.from('auction'), f.mint.toBuffer()], HOOK)[0];
  const init = { programId: HOOK, data: Buffer.concat([Buffer.from([6]), u64(MIN_BID), u64(INCREMENT_BPS), u64(DURATION), u64(EXTENSION), f.payer.publicKey.toBuffer()]),
    keys: [meta(f.payer.publicKey, true, true), meta(f.mint), meta(f.config), meta(address, true), meta(SystemProgram.programId)] };
  if (legacyFirst) {
    // Plant a deployed-format Dutch auction account (HKAUCT01, 224 bytes) at round 7 with a past winner.
    const data = Buffer.alloc(224); data.write('HKAUCT01', 0);
    f.mint.toBuffer().copy(data, 8); f.payer.publicKey.toBuffer().copy(data, 40); f.payer.publicKey.toBuffer().copy(data, 72);
    data.writeBigUInt64LE(100_000_000n, 104); data.writeBigUInt64LE(10_000_000n, 112); data.writeBigUInt64LE(1800n, 120);
    data.writeBigUInt64LE(7n, 128); data.writeBigInt64LE(5n, 136); Keypair.generate().publicKey.toBuffer().copy(data, 144);
    HOOK.toBuffer().copy(data, 176); data.writeBigUInt64LE(42_000_000n, 208); data.writeBigInt64LE(9n, 216);
    f.svm.setAccount(address, { lamports: Number(f.svm.minimumBalanceForRentExemption(224n)), data, owner: HOOK, executable: false, rentEpoch: 0 });
  }
  f.succeeds(f.send([init]));
  const bidders = [0, 1].map(() => { const k = Keypair.generate(); f.svm.airdrop(k.publicKey, 1_000_000_000n); return { keypair: k, holding: f.account(k.publicKey, 1n) }; });
  const state = () => Buffer.from(f.svm.getAccount(address).data);
  const read = () => { const d = state(); return { round: d.readBigUInt64LE(136), ends: d.readBigInt64LE(152), bidder: new PublicKey(d.subarray(160, 192)),
    bid: d.readBigUInt64LE(192), hook: new PublicKey(d.subarray(200, 232)), winner: new PublicKey(d.subarray(232, 264)), paid: d.readBigUInt64LE(264) }; };
  const previous = () => { const d = read(); return d.bid > 0n ? d.bidder : null; };
  const bid = (who, amount, { round = read().round, hook = HOOK, prev = previous() ?? who.keypair.publicKey } = {}) => ({ programId: HOOK,
    data: Buffer.concat([Buffer.from([7]), u64(round), u64(amount), hook.toBuffer()]), keys: [
      meta(who.keypair.publicKey, true, true), meta(f.mint), meta(f.config), meta(address, true), meta(prev, true),
      meta(hook), meta(f.eaml), meta(SystemProgram.programId), meta(who.holding)] });
  const settle = (round = read().round) => ({ programId: HOOK, data: Buffer.concat([Buffer.from([8]), u64(round)]), keys: [
    meta(f.payer.publicKey, false, true), meta(f.mint, true), meta(f.config), meta(address, true), meta(f.payer.publicKey, true),
    meta(HOOK), meta(f.eaml), meta(TOKEN_2022_PROGRAM_ID), meta(SystemProgram.programId)] });
  const voidIx = (round = read().round) => ({ programId: HOOK, data: Buffer.concat([Buffer.from([9]), u64(round)]), keys: [
    meta(f.payer.publicKey, false, true), meta(f.mint), meta(f.config), meta(address, true), meta(read().bidder, true)] });
  const at = (unix) => { const clock = f.svm.getClock(); clock.unixTimestamp = BigInt(unix); f.svm.setClock(clock); };
  const balance = (who) => f.svm.getBalance(who.keypair.publicKey);
  at(1000);
  return { ...f, address, bidders, state, read, bid, settle, voidIx, at, balance };
}

test('the first bid escrows SOL in the auction account and starts the clock', () => {
  const f = auctionFixture(); const [a] = f.bidders;
  const before = f.balance(a), escrowBefore = f.svm.getBalance(f.address);
  f.succeeds(f.send([f.bid(a, MIN_BID)], [a.keypair]));
  const s = f.read();
  assert.equal(before - f.balance(a), MIN_BID);
  assert.equal(f.svm.getBalance(f.address) - escrowBefore, MIN_BID);
  assert.equal(s.ends, 1000n + DURATION); assert.equal(s.bid, MIN_BID); assert(s.bidder.equals(a.keypair.publicKey));
});

test('a higher bid refunds the previous leader in the same instruction', () => {
  const f = auctionFixture(); const [a, b] = f.bidders;
  f.succeeds(f.send([f.bid(a, MIN_BID)], [a.keypair]));
  const aAfterBid = f.balance(a);
  f.succeeds(f.send([f.bid(b, 11_000_000n)], [b.keypair]));
  assert.equal(f.balance(a) - aAfterBid, MIN_BID, 'outbid leader is made whole');
  assert(f.read().bidder.equals(b.keypair.publicKey)); assert.equal(f.read().bid, 11_000_000n);
  assert.equal(f.svm.getBalance(f.address) - f.svm.minimumBalanceForRentExemption(312n), 11_000_000n, 'only the leading bid stays escrowed');
});

test('a raise below the minimum increment is rejected and nothing moves', () => {
  const f = auctionFixture(); const [a, b] = f.bidders;
  f.succeeds(f.send([f.bid(a, MIN_BID)], [a.keypair]));
  const before = f.balance(b);
  assert(failed(f.send([f.bid(b, 10_999_999n)], [b.keypair])));
  assert.equal(f.balance(b), before); assert(f.read().bidder.equals(a.keypair.publicKey));
  assert(failed(f.send([f.bid(b, MIN_BID - 1n)], [b.keypair])), 'below the opening minimum on a fresh round is also rejected');
});

test('naming the wrong previous bidder cannot redirect the refund', () => {
  const f = auctionFixture(); const [a, b] = f.bidders;
  f.succeeds(f.send([f.bid(a, MIN_BID)], [a.keypair]));
  assert(failed(f.send([f.bid(b, 20_000_000n, { prev: b.keypair.publicKey })], [b.keypair])));
});

test('bids inside the anti-snipe window push the end out; earlier bids do not', () => {
  const f = auctionFixture(); const [a, b] = f.bidders;
  f.succeeds(f.send([f.bid(a, MIN_BID)], [a.keypair]));
  f.at(1500); f.succeeds(f.send([f.bid(b, 11_000_000n)], [b.keypair]));
  assert.equal(f.read().ends, 2800n, 'an early raise leaves the clock alone');
  f.at(2700); f.succeeds(f.send([f.bid(a, 12_100_000n)], [a.keypair]));
  assert.equal(f.read().ends, 2700n + EXTENSION, 'a last-minute raise extends the round');
  f.at(2950); f.succeeds(f.send([f.bid(b, 13_310_000n)], [b.keypair]));
  assert.equal(f.read().ends, 2950n + EXTENSION, 'each late raise extends again');
});

test('bids after the clock runs out are rejected and settlement is refused while it is live', () => {
  const f = auctionFixture(); const [a, b] = f.bidders;
  f.succeeds(f.send([f.bid(a, MIN_BID)], [a.keypair]));
  assert(failed(f.send([f.settle()])), 'cannot settle a live round');
  f.at(2800);
  const before = f.balance(b);
  assert(failed(f.send([f.bid(b, 50_000_000n)], [b.keypair])));
  assert.equal(f.balance(b), before);
});

test('settlement pays the seller, changes only the hook pointer, keeps the literal authority, and opens the next round', () => {
  const f = auctionFixture(); const [a, b] = f.bidders;
  f.succeeds(f.send([f.bid(a, MIN_BID)], [a.keypair]));
  f.succeeds(f.send([f.bid(b, 11_000_000n)], [b.keypair]));
  f.at(2800);
  const seller = f.svm.getBalance(f.payer.publicKey);
  const result = f.succeeds(f.send([f.settle()]));
  const s = f.read();
  assert.equal(f.svm.getBalance(f.payer.publicKey) - seller, 11_000_000n - 5000n, "seller receives the bid minus the 5000-lamport fee it paid"); void result;
  assert.equal(s.round, 2n); assert.equal(s.bid, 0n); assert.equal(s.ends, 0n);
  assert(s.winner.equals(b.keypair.publicKey)); assert.equal(s.paid, 11_000_000n);
  const mint = unpackMint(f.mint, { ...f.svm.getAccount(f.mint), data: Buffer.from(f.svm.getAccount(f.mint).data) }, TOKEN_2022_PROGRAM_ID);
  assert(getTransferHook(mint).authority.equals(f.payer.publicKey), 'Literal hook authority must stay with the seller');
  assert(getTransferHook(mint).programId.equals(HOOK));
  assert.equal(f.svm.getBalance(f.address), f.svm.minimumBalanceForRentExemption(312n), 'escrow fully released');
});

test('settlement without a bid, with a stale round, or without the seller signature fails', () => {
  const f = auctionFixture(); const [a] = f.bidders;
  assert(failed(f.send([f.settle()])), 'no bid yet');
  f.succeeds(f.send([f.bid(a, MIN_BID)], [a.keypair])); f.at(2800);
  assert(failed(f.send([f.settle(5n)])), 'stale round');
  const ix = f.settle(); ix.keys[0] = meta(Keypair.generate().publicKey, false, false);
  assert(failed(f.send([ix])), 'unsigned authority');
});

test('the next round accepts bids again and the old round number is stale', () => {
  const f = auctionFixture(); const [a, b] = f.bidders;
  f.succeeds(f.send([f.bid(a, MIN_BID)], [a.keypair])); f.at(2800); f.succeeds(f.send([f.settle()]));
  assert(failed(f.send([f.bid(b, MIN_BID, { round: 1n })], [b.keypair])));
  f.succeeds(f.send([f.bid(b, MIN_BID)], [b.keypair]));
  assert.equal(f.read().round, 2n); assert.equal(f.read().ends, 2800n + DURATION);
});

test('void refunds the leader in full and reopens as a new round', () => {
  const f = auctionFixture(); const [a] = f.bidders;
  f.succeeds(f.send([f.bid(a, 25_000_000n)], [a.keypair]));
  const after = f.balance(a);
  const ix = f.voidIx(); ix.keys[4] = meta(Keypair.generate().publicKey, true, false);
  assert(failed(f.send([ix])), 'refund must go to the actual leader');
  f.succeeds(f.send([f.voidIx()]));
  assert.equal(f.balance(a) - after, 25_000_000n);
  assert.equal(f.read().round, 2n); assert.equal(f.read().bid, 0n);
});

test('a bidder with zero holdings cannot bid', () => {
  const f = auctionFixture(); const [a] = f.bidders;
  const info = f.svm.getAccount(a.holding); const data = Buffer.from(info.data); data.writeBigUInt64LE(0n, 64);
  f.svm.setAccount(a.holding, { ...info, rentEpoch: 0, data });
  const before = f.balance(a);
  assert(failed(f.send([f.bid(a, MIN_BID)], [a.keypair])));
  assert.equal(f.balance(a), before);
});

test('a hook without a wired ExtraAccountMetaList cannot be proposed', () => {
  const f = auctionFixture(); const [a] = f.bidders;
  assert(failed(f.send([f.bid(a, MIN_BID, { hook: TOKEN_2022_PROGRAM_ID })], [a.keypair])));
});

test('a deployed Dutch auction account migrates in place, keeping its round counter and last result', () => {
  const f = auctionFixture({ legacyFirst: true });
  const d = f.state();
  assert.equal(d.length, 312); assert.equal(d.subarray(0, 8).toString(), 'HKAUCT02');
  assert.equal(f.read().round, 7n); assert.equal(f.read().paid, 42_000_000n); assert(f.read().winner !== PublicKey.default);
  assert.equal(d.readBigUInt64LE(104), MIN_BID); assert.equal(d.readBigUInt64LE(128), EXTENSION);
  const [a] = f.bidders; f.succeeds(f.send([f.bid(a, MIN_BID)], [a.keypair]));
});

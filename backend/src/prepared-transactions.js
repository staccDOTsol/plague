// Stateless prepare receipts survive load balancing and restarts. The signing
// wallet must sign the exact prepared message; auction authority co-signs last.
import { createHash, createPublicKey, createHmac, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { TradeError } from './trade-errors.js';

// Wallets such as Phantom append Lighthouse assertion instructions to a
// transaction before signing it, which changes the raw message bytes. The
// receipt therefore binds the *intent*: fee payer, blockhash, and every
// non-guard instruction's program, resolved account keys, signer flags, and
// data. Guard instructions can only assert and abort, never move value.
const GUARD_PROGRAMS = new Set(['L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95']);
export function intentHash(message) {
  const statics = message.staticAccountKeys;
  const resolve = (index) => statics[index]?.toBase58() ?? `lookup:${index}`;
  const parts = [resolve(0), message.recentBlockhash];
  for (const ix of message.compiledInstructions) {
    const program = resolve(ix.programIdIndex);
    if (GUARD_PROGRAMS.has(program)) continue;
    parts.push(program, ix.accountKeyIndexes.map((index) => `${resolve(index)}${message.isAccountSigner(index) ? '!' : ''}`).join(','),
      Buffer.from(ix.data).toString('base64'));
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}
export function messageHash(tx) {
  return intentHash(tx.message);
}
export function isGuardProgram(address) { return GUARD_PROGRAMS.has(address); }

export function createPreparationReceipts() {
  const configured = process.env.TRADER_PREPARE_SECRET;
  if (process.env.NODE_ENV === 'production' && !configured) throw new Error('TRADER_PREPARE_SECRET is required in production');
  const secret = configured ? Buffer.from(configured, 'hex') : randomBytes(32);
  if (secret.length < 32) throw new Error('TRADER_PREPARE_SECRET must contain at least 32 random bytes');
  const sign = (body) => createHmac('sha256', secret).update(body).digest('base64url');
  return {
    issue(tx, record) {
      const body = Buffer.from(JSON.stringify({ ...record, hash: messageHash(tx),
        issuedAt: Date.now(), expiresAt: Date.now() + 120_000 })).toString('base64url');
      return `${body}.${sign(body)}`;
    },
    read(token, allowExpired = false) {
      if (typeof token !== 'string' || token.length > 2400) throw new TradeError(400, 'BAD_RECEIPT', 'Invalid transaction preparation receipt.');
      const [body, signature, extra] = token.split('.');
      const actual = Buffer.from(signature || '', 'base64url');
      const expected = Buffer.from(sign(body || ''), 'base64url');
      if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new TradeError(400, 'BAD_RECEIPT', 'The transaction preparation receipt does not match. Refresh the quote.');
      }
      let record;
      try { record = JSON.parse(Buffer.from(body, 'base64url').toString()); }
      catch { throw new TradeError(400, 'BAD_RECEIPT', 'Invalid transaction preparation receipt.'); }
      if ((!allowExpired && Date.now() > record.expiresAt) || Date.now() - record.issuedAt > 3_600_000) {
        throw new TradeError(409, 'QUOTE_EXPIRED', 'This preparation has expired. Refresh the quote before signing.');
      }
      return record;
    },
  };
}

export function verifyBuyerSigned(tx, record) {
  if (messageHash(tx) !== record.hash || !tx.message.staticAccountKeys[0]?.equals(new PublicKey(record.buyer))) {
    throw new TradeError(400, 'TRANSACTION_CHANGED', 'The wallet changed the prepared transaction. Request a fresh quote.');
  }
  const signature = tx.signatures[0];
  const key = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(record.buyer).toBuffer(),
  ]) });
  if (!signature || !verify(null, tx.message.serialize(), key, signature)) {
    throw new TradeError(400, 'BUYER_SIGNATURE_REQUIRED', 'The connected buyer wallet must sign this exact transaction first.');
  }
}

export function decodeSignedTransaction(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 4000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new TradeError(400, 'BAD_TRANSACTION', 'Invalid signed transaction.');
  }
  try { return VersionedTransaction.deserialize(Buffer.from(encoded, 'base64')); }
  catch { throw new TradeError(400, 'BAD_TRANSACTION', 'The signed transaction could not be decoded.'); }
}

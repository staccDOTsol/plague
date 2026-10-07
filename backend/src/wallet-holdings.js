import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { TradeError } from './trade-errors.js';
import { WSOL } from './router-markets.js';

export async function mintHoldings(connection, owner, mint, program = TOKEN_2022_PROGRAM_ID) {
  const result = await connection.getTokenAccountsByOwner(owner, { mint }, 'confirmed');
  const accounts = result.value.filter(({ account }) => account.owner.equals(program) && account.data.length >= 72 &&
    account.data.subarray(0, 32).equals(mint.toBuffer()) && account.data.subarray(32, 64).equals(owner.toBuffer()))
    .map(({ pubkey, account }) => ({ address: pubkey, amount: account.data.readBigUInt64LE(64), info: account }));
  const canonical = getAssociatedTokenAddressSync(mint, owner, false, program);
  accounts.sort((a, b) => a.address.equals(canonical) ? -1 : b.address.equals(canonical) ? 1 : a.amount > b.amount ? -1 : 1);
  return { accounts, total: accounts.reduce((sum, account) => sum + account.amount, 0n), canonical };
}

export async function requireHolder(connection, owner, market) {
  const holdings = await mintHoldings(connection, owner, new PublicKey(market.mint));
  if (holdings.total === 0n) throw new TradeError(403, 'EXISTING_HOLDER_REQUIRED',
    `This wallet does not already hold ${market.label}. A positive balance of this same mint is required before buying or receiving more. Connect an existing-holder wallet.`,
    { mint: market.mint, buyer: owner.toBase58(), heldRaw: '0' });
  return holdings;
}

export async function walletBalances(connection, owner) {
  const [sol, classic, extended] = await Promise.all([
    connection.getBalance(owner, 'confirmed'),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, 'confirmed'),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, 'confirmed'),
  ]);
  const balances = {};
  for (const { account } of [...classic.value, ...extended.value]) {
    const info = account.data.parsed?.info;
    if (!info?.tokenAmount) continue;
    const prior = BigInt(balances[info.mint]?.amount || '0');
    const raw = prior + BigInt(info.tokenAmount.amount);
    balances[info.mint] = { amount: raw.toString(), uiAmount: Number(raw) / 10 ** info.tokenAmount.decimals,
      decimals: info.tokenAmount.decimals, slot: Math.max(classic.context.slot, extended.context.slot),
      isFrozen: info.state === 'frozen' };
  }
  const native = BigInt(sol) + BigInt(balances[WSOL]?.amount || '0');
  balances[WSOL] = { amount: native.toString(), uiAmount: Number(native) / 1e9,
    decimals: 9, slot: Math.max(classic.context.slot, extended.context.slot), isFrozen: false };
  return balances;
}

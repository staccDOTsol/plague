// Splash Pool for dummies: a guided Orca Whirlpool flow for Token-2022 mints,
// including transfer-hook mints. Every step is a wallet-signed, fully simulated
// transaction prepared here and relayed by /submit. Ephemeral accounts (config,
// vaults, position mint) are signed server-side before the packet is returned.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { Percentage } from '@orca-so/common-sdk';
import {
  PDAUtil, PriceMath, TickUtil, TokenExtensionUtil, WhirlpoolContext, WhirlpoolIx, ParsableWhirlpool, ParsablePosition, ParsableWhirlpoolsConfig, ParsableFeeTier,
  ORCA_WHIRLPOOL_PROGRAM_ID, SPLASH_POOL_TICK_SPACING, WHIRLPOOL_NFT_UPDATE_AUTH,
  increaseLiquidityQuoteByInputTokenWithParams, decreaseLiquidityQuoteByLiquidityWithParams,
} from '@orca-so/whirlpools-sdk';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, ExtensionType, getExtensionTypes, getExtensionData, getTransferHook, unpackMint,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction,
} from '@solana/spl-token';
import { unpack as unpackTokenMetadata } from '@solana/spl-token-metadata';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { HOOK, WSOL, USDC, MARKET_BY_MINT } from './router-markets.js';
import { simulatePacket } from './hooked-router.js';
import { decodeSignedTransaction, verifyBuyerSigned } from './prepared-transactions.js';
import { TradeError, tradeFailure } from './trade-errors.js';

const ORCA = ORCA_WHIRLPOOL_PROGRAM_ID;
const PUBLIC_CONFIG = new PublicKey('2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ'); // Orca's own config: public fee tiers, badges issued by Orca only
const SPACING = SPLASH_POOL_TICK_SPACING;
const DEFAULT_FEE_RATE = 3000; // 0.30 %
const ALLOWED_FEE_RATES = new Set([1000, 3000, 10000, 30000]);
const COUNTERS = { [WSOL]: 'SOL', [USDC]: 'USDC' };
const key = (value) => { try { return typeof value === 'string' ? new PublicKey(value) : null; } catch { return null; } };
const ixs = (bundle) => [...bundle.instructions, ...bundle.cleanupInstructions];
const raw = (value) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) ? new BN(value) : null;
const fail = (response, error) => { const result = tradeFailure(error); response.status(result.status).json(result.body); };
const ui = (amount, decimals) => new Decimal(amount.toString()).div(new Decimal(10).pow(decimals)).toFixed();
const slippage = (bps) => Percentage.fromFraction(bps, 10_000);

function birdeyeKey() {
  if (process.env.BIRDEYE_API_KEY) return process.env.BIRDEYE_API_KEY.trim();
  try { return readFileSync(`${homedir()}/birdeye.key`, 'utf8').trim(); } catch { return null; }
}

async function birdeyePrice(mint) {
  const apiKey = birdeyeKey();
  if (!apiKey) return null;
  try {
    const response = await fetch(`https://public-api.birdeye.so/defi/price?address=${mint}`, {
      headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana', accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    const body = await response.json();
    if (!response.ok || !body?.success || !(body.data?.value > 0)) return null;
    return { usd: body.data.value, inSol: body.data.priceInNative || null, updatedAt: body.data.updateUnixTime || null };
  } catch { return null; }
}

const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
function token2022Symbol(mint) {
  try {
    const data = getExtensionData(ExtensionType.TokenMetadata, mint.tlvData);
    return data ? unpackTokenMetadata(data).symbol?.trim() || null : null;
  } catch { return null; }
}
async function metaplexSymbol(connection, address) {
  try {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), address.toBuffer()], METAPLEX);
    const info = await connection.getAccountInfo(pda, 'confirmed');
    if (!info) return null;
    const nameLength = info.data.readUInt32LE(65);
    const symbolOffset = 69 + nameLength;
    const symbolLength = info.data.readUInt32LE(symbolOffset);
    return info.data.subarray(symbolOffset + 4, symbolOffset + 4 + symbolLength).toString('utf8').replace(/\0+$/, '').trim() || null;
  } catch { return null; }
}
const counterInfoSymbol = (pair) => pair.counterInfo.symbol || 'counter';
async function symbolFor(connection, address, mint) {
  const base58 = address.toBase58();
  return COUNTERS[base58] || MARKET_BY_MINT.get(base58)?.label || token2022Symbol(mint) || await metaplexSymbol(connection, address) || null;
}
async function mintDetails(connection, address) {
  const info = await connection.getAccountInfo(address, 'confirmed');
  if (!info || (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID))) {
    throw new TradeError(422, 'MINT_UNAVAILABLE', 'That address is not an initialized SPL or Token-2022 mint.');
  }
  const mint = unpackMint(address, info, info.owner);
  const extensions = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? getExtensionTypes(mint.tlvData).map((type) => ExtensionType[type]) : [];
  const hook = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? getTransferHook(mint) : null;
  const hookProgram = hook?.programId && !hook.programId.equals(PublicKey.default) ? hook.programId.toBase58() : null;
  return { address: address.toBase58(), decimals: mint.decimals, tokenProgram: info.owner.toBase58(), extensions, hookProgram, symbol: await symbolFor(connection, address, mint),
    badgeRequired: info.owner.equals(TOKEN_2022_PROGRAM_ID) && extensions.some((name) => ['TransferHook', 'PermanentDelegate', 'TransferFeeConfig'].includes(name)) || Boolean(hookProgram),
    mint: { ...mint, tokenProgram: info.owner } };
}

function context(connection) {
  return WhirlpoolContext.from(connection, new Wallet(Keypair.generate()), undefined, undefined, {}, ORCA);
}

async function findPools(connection, mintA, mintB) {
  const accounts = await connection.getProgramAccounts(ORCA, { commitment: 'confirmed', filters: [
    { dataSize: 653 }, { memcmp: { offset: 101, bytes: mintA.toBase58() } }, { memcmp: { offset: 181, bytes: mintB.toBase58() } }] });
  return accounts.map(({ pubkey, account }) => ({ address: pubkey, data: ParsableWhirlpool.parse(pubkey, account) })).filter((pool) => pool.data)
    .sort((x, y) => (x.data.tickSpacing === SPACING ? 0 : 1) - (y.data.tickSpacing === SPACING ? 0 : 1) || y.data.liquidity.cmp(x.data.liquidity));
}

function describePool(pool, a, b, inverted) {
  const priceBPerA = PriceMath.sqrtPriceX64ToPrice(pool.data.sqrtPrice, a.decimals, b.decimals);
  return { address: pool.address.toBase58(), config: pool.data.whirlpoolsConfig.toBase58(), tickSpacing: pool.data.tickSpacing,
    splash: pool.data.tickSpacing === SPACING, feeRateBps: pool.data.feeRate, liquidity: pool.data.liquidity.toString(),
    priceTokenBPerTokenA: priceBPerA.toFixed(), priceCounterPerMint: (inverted ? new Decimal(1).div(priceBPerA) : priceBPerA).toFixed(),
    tokenVaultA: pool.data.tokenVaultA.toBase58(), tokenVaultB: pool.data.tokenVaultB.toBase58() };
}

async function walletPositions(connection, ctx, owner, poolAddress) {
  const owned = [];
  for (const programId of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
    const accounts = await connection.getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed');
    for (const { pubkey, account } of accounts.value) {
      const info = account.data.parsed?.info;
      if (info?.tokenAmount?.amount === '1' && info.tokenAmount.decimals === 0) owned.push({ tokenAccount: pubkey, mint: new PublicKey(info.mint), programId });
    }
  }
  if (!owned.length) return [];
  const addresses = owned.map((entry) => PDAUtil.getPosition(ORCA, entry.mint).publicKey);
  const infos = await connection.getMultipleAccountsInfo(addresses, 'confirmed');
  const positions = [];
  infos.forEach((info, i) => {
    if (!info?.owner.equals(ORCA)) return;
    const data = ParsablePosition.parse(addresses[i], info);
    if (data && data.whirlpool.equals(poolAddress)) positions.push({ address: addresses[i], data, mint: owned[i].mint, tokenAccount: owned[i].tokenAccount, tokenProgram: owned[i].programId });
  });
  return positions;
}

// Orca's program no longer lets wallets create new Whirlpools configs, so a
// hook mint can only get a token badge under a config whose badge authority the
// wallet already holds. Discover those, plus Orca's public config for mints
// that need no badge.
// Orca's program no longer lets wallets create new Whirlpools configs, so a
// hook mint can only live under a config that already badges it, or one whose
// badge authority the wallet holds. Anyone may initialize a pool on a config
// once the badges exist; Orca's public config works for mints needing none.
const TOKEN_BADGE_DISCRIMINATOR = Buffer.from([116, 219, 204, 229, 249, 116, 255, 150]);
async function describeConfig(connection, config, wallet, a, b) {
  const feeTier = PDAUtil.getFeeTier(ORCA, config, SPACING).publicKey;
  const extension = PDAUtil.getConfigExtension(ORCA, config).publicKey;
  const [cfgInfo, tierInfo, extInfo, badgeA, badgeB] = await connection.getMultipleAccountsInfo([config, feeTier, extension,
    PDAUtil.getTokenBadge(ORCA, config, key(a.address)).publicKey, PDAUtil.getTokenBadge(ORCA, config, key(b.address)).publicKey], 'confirmed');
  const data = cfgInfo ? ParsableWhirlpoolsConfig.parse(config, cfgInfo) : null;
  if (!data) return null;
  const badgeAuthority = extInfo ? new PublicKey(extInfo.data.subarray(72, 104)) : null;
  const missingBadges = [a, b].filter((side, i) => side.badgeRequired && ![badgeA, badgeB][i]).map((side) => side.address);
  const controlsBadges = Boolean(wallet && badgeAuthority?.equals(wallet));
  return { address: config.toBase58(), public: config.equals(PUBLIC_CONFIG), feeAuthority: data.feeAuthority.toBase58(), badgeAuthority: badgeAuthority?.toBase58() || null,
    controlsFees: Boolean(wallet && data.feeAuthority.equals(wallet)), controlsBadges,
    splashFeeTier: tierInfo ? { address: feeTier.toBase58(), feeRateBps: ParsableFeeTier.parse(feeTier, tierInfo)?.defaultFeeRate ?? null } : null,
    badges: { [a.address]: Boolean(badgeA), [b.address]: Boolean(badgeB) }, missingBadges,
    usable: (missingBadges.length === 0 && Boolean(tierInfo)) || (controlsBadges && (Boolean(tierInfo) || Boolean(wallet && data.feeAuthority.equals(wallet)))),
    needsBadgeStep: missingBadges.length > 0 || !tierInfo };
}
async function candidateConfigs(connection, wallet, a, b) {
  const sides = [a, b].filter((side) => side.badgeRequired);
  const badged = (await Promise.all(sides.map((side) => connection.getProgramAccounts(ORCA, { commitment: 'confirmed', dataSlice: { offset: 8, length: 32 },
    filters: [{ memcmp: { offset: 0, bytes: TOKEN_BADGE_DISCRIMINATOR.toString('base64'), encoding: 'base64' } }, { memcmp: { offset: 40, bytes: key(side.address).toBase58() } }] })))).flat();
  const controlled = wallet ? await connection.getProgramAccounts(ORCA, { commitment: 'confirmed', dataSlice: { offset: 8, length: 32 },
    filters: [{ dataSize: 616 }, { memcmp: { offset: 72, bytes: wallet.toBase58() } }] }) : [];
  const addresses = [...new Set([PUBLIC_CONFIG.toBase58(), ...badged.map(({ account }) => new PublicKey(account.data).toBase58()), ...controlled.map(({ account }) => new PublicKey(account.data).toBase58())])];
  const described = await Promise.all(addresses.slice(0, 200).map((address) => describeConfig(connection, new PublicKey(address), wallet, a, b)));
  return described.filter(Boolean);
}

async function loadPair(connection, body) {
  const mint = key(body?.mint), counter = key(body?.counter || WSOL);
  if (!mint || !counter || mint.equals(counter)) throw new TradeError(400, 'INVALID_PAIR', 'Choose a mint and a different counter token.');
  const [mintInfo, counterInfo] = await Promise.all([mintDetails(connection, mint), mintDetails(connection, counter)]);
  const [first] = [mint, counter].sort((x, y) => Buffer.compare(x.toBuffer(), y.toBuffer()));
  const inverted = !first.equals(mint); // Orca orders token A/B by address, not by which one you consider "the token"
  const a = inverted ? counterInfo : mintInfo, b = inverted ? mintInfo : counterInfo;
  return { mint, counter, mintInfo, counterInfo, a, b, inverted, tokenA: key(a.address), tokenB: key(b.address) };
}

export async function liquidityOverview(connection, body) {
  const pair = await loadPair(connection, body);
  const wallet = body?.wallet ? key(body.wallet) : null;
  const ctx = context(connection);
  const [pools, mintPrice, counterPrice] = await Promise.all([
    findPools(connection, pair.tokenA, pair.tokenB), birdeyePrice(pair.mint.toBase58()), birdeyePrice(pair.counter.toBase58())]);
  const splash = pools.find((pool) => pool.data.tickSpacing === SPACING) || pools[0] || null;
  let pricing = null;
  if (mintPrice && counterPrice) {
    const counterPerMint = new Decimal(mintPrice.usd).div(counterPrice.usd);
    pricing = { source: 'birdeye', mintUsd: mintPrice.usd, counterUsd: counterPrice.usd, updatedAt: mintPrice.updatedAt,
      counterPerMint: counterPerMint.toFixed(), tokenBPerTokenA: (pair.inverted ? new Decimal(1).div(counterPerMint) : counterPerMint).toFixed() };
  }
  const positions = wallet && splash ? await walletPositions(connection, ctx, wallet, splash.address) : [];
  const warnings = [];
  const configs = splash ? [] : await candidateConfigs(connection, wallet, pair.a, pair.b);
  const rank = (config) => (config.usable ? 0 : 8) + (config.missingBadges.length ? 2 : 0) + (config.splashFeeTier ? 0 : 1) + (config.public ? 4 : 0);
  const usableConfig = [...configs].sort((x, y) => rank(x) - rank(y))[0] ?? null;
  if (usableConfig && !usableConfig.usable) warnings.push('None of the configs this wallet controls can badge this mint.');
  const market = MARKET_BY_MINT.get(pair.mint.toBase58());
  if (!splash && !usableConfig?.usable) warnings.push(pair.mintInfo.badgeRequired || pair.counterInfo.badgeRequired
    ? 'This Token-2022 mint needs an Orca token badge before a pool can hold it, and Orca’s program no longer lets wallets create their own configs. Connect the wallet that is badge authority on an existing config, or ask Orca to badge the mint on its public config.'
    : 'No usable Whirlpools config was found for this wallet.');
  if (!splash && pair.mintInfo.hookProgram === HOOK) warnings.push('This mint’s hook only lets existing holders receive it. A brand-new pool vault holds nothing, so its first deposit would revert. Add liquidity to the existing pool instead.');
  if (!pricing) warnings.push('No Birdeye price for this pair yet. Enter the starting price yourself; it only sets the first trade’s price and liquidity then moves it.');
  if (pricing && splash) {
    const raw = new Decimal(PriceMath.sqrtPriceX64ToPrice(splash.data.sqrtPrice, pair.a.decimals, pair.b.decimals).toString());
    const poolPrice = pair.inverted ? new Decimal(1).div(raw) : raw, marketPrice = new Decimal(pricing.counterPerMint);
    if (poolPrice.gt(0) && marketPrice.gt(0)) {
      const ratio = poolPrice.div(marketPrice);
      if (ratio.gt(2) || ratio.lt(0.5)) warnings.push(`Pool price is ${ratio.gt(1) ? `${ratio.toFixed(0)}× above` : `${new Decimal(1).div(ratio).toFixed(0)}× below`} the Birdeye market price (${poolPrice.toSignificantDigits(6)} vs ${marketPrice.toSignificantDigits(6)} ${counterInfoSymbol(pair)} per token). Full-range deposits are matched at the pool price, so the cheaper side would go to the first arbitrageur. Trade the pool back toward market, or use a different pool, before depositing.`);
    }
  }
  const [lowerTick, upperTick] = TickUtil.getFullRangeTickIndex(splash?.data.tickSpacing || SPACING);
  return {
    chain: 'mainnet-beta', mint: { ...pair.mintInfo, mint: undefined, symbol: market?.label || pair.mintInfo.symbol || null }, counter: { ...pair.counterInfo, mint: undefined, symbol: pair.counterInfo.symbol || null },
    order: { tokenA: pair.a.address, tokenB: pair.b.address, inverted: pair.inverted,
      explanation: pair.inverted
        ? `Orca sorts the pair by address, so ${pair.counterInfo.symbol || 'the counter token'} is token A and your mint is token B. Orca’s raw price is therefore “mint per ${pair.counterInfo.symbol || 'counter'}”, the inverse of the price you think in. The wizard flips it for you; the figures below show both.`
        : `Orca sorts the pair by address, so your mint is token A and ${pair.counterInfo.symbol || 'the counter token'} is token B. Orca’s raw price is “${pair.counterInfo.symbol || 'counter'} per mint”, the same direction you think in.` },
    pricing, pools: pools.map((pool) => describePool(pool, pair.a, pair.b, pair.inverted)), pool: splash ? describePool(splash, pair.a, pair.b, pair.inverted) : null,
    fullRange: { lowerTick, upperTick, tickSpacing: splash?.data.tickSpacing || SPACING },
    positions: positions.map((position) => ({ address: position.address.toBase58(), mint: position.mint.toBase58(), liquidity: position.data.liquidity.toString(),
      tickLowerIndex: position.data.tickLowerIndex, tickUpperIndex: position.data.tickUpperIndex,
      feeOwedA: position.data.feeOwedA.toString(), feeOwedB: position.data.feeOwedB.toString(), fullRange: TickUtil.isFullRange(splash.data.tickSpacing, position.data.tickLowerIndex, position.data.tickUpperIndex) })),
    configs: [...configs].sort((x, y) => rank(x) - rank(y)).slice(0, 12), configCount: configs.length, config: usableConfig,
    plan: splash
      ? [{ id: 'open', label: 'Open a full-range position and deposit', done: false }, { id: 'manage', label: 'Increase, decrease, collect, or close', done: false }]
      : [...(usableConfig?.needsBadgeStep ? [{ id: 'badge', label: usableConfig.missingBadges.length ? 'Issue the token badge (and Splash fee tier) on your config' : 'Add a Splash fee tier to your config', done: false }] : []),
        { id: 'pool', label: 'Initialize the Splash Pool and its two tick arrays', done: false },
        { id: 'open', label: 'Open a full-range position and make the first deposit', done: false }],
    warnings, feeRateOptions: [...ALLOWED_FEE_RATES], defaultFeeRateBps: DEFAULT_FEE_RATE,
  };
}

async function packet(connection, wallet, instructions, label, ephemeral = []) {
  const prepared = await simulatePacket(connection, wallet, instructions, label);
  if (ephemeral.length) prepared.tx.sign(ephemeral);
  return { tx: prepared.tx, public: { ...prepared.public, transaction: Buffer.from(prepared.tx.serialize()).toString('base64'),
    ephemeralSigners: ephemeral.map((keypair) => keypair.publicKey.toBase58()) } };
}

function wrapSol(connection, wallet, lamports) {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, wallet, false, TOKEN_PROGRAM_ID);
  return { ata, before: [createAssociatedTokenAccountIdempotentInstruction(wallet, ata, wallet, NATIVE_MINT, TOKEN_PROGRAM_ID),
    ...(lamports.gtn(0) ? [SystemProgram.transfer({ fromPubkey: wallet, toPubkey: ata, lamports: BigInt(lamports.toString()) }), createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID)] : [])] };
}

async function existingAccount(connection, address) {
  return Boolean(await connection.getAccountInfo(address, 'confirmed'));
}

export async function prepareLiquidity(connection, body) {
  const wallet = key(body?.wallet);
  if (!wallet || !PublicKey.isOnCurve(wallet.toBuffer())) throw new TradeError(400, 'INVALID_WALLET', 'Connect a wallet first.');
  const action = body?.action;
  const pair = await loadPair(connection, body);
  const ctx = context(connection);
  const base = { chain: 'mainnet-beta', engine: 'liquidity', stage: action, wallet: wallet.toBase58(), mint: pair.mint.toBase58(), counter: pair.counter.toBase58(),
    tokenA: pair.a.address, tokenB: pair.b.address, inverted: pair.inverted };
  const slip = Number.isInteger(body.slippageBps) && body.slippageBps >= 10 && body.slippageBps <= 2000 ? body.slippageBps : 100;

  if (action === 'badge') {
    const config = key(body.config);
    if (!config) throw new TradeError(400, 'CONFIG_REQUIRED', 'Choose a Whirlpools config you control.');
    const found = await describeConfig(connection, config, wallet, pair.a, pair.b);
    if (!found || (found.missingBadges.length && !found.controlsBadges)) throw new TradeError(422, 'CONFIG_NOT_CONTROLLED', 'This wallet is not the token-badge authority on that config.');
    const feeRate = body.feeRateBps ?? DEFAULT_FEE_RATE;
    if (!ALLOWED_FEE_RATES.has(feeRate)) throw new TradeError(400, 'INVALID_FEE_RATE', 'Choose one of the offered fee rates.');
    const extension = PDAUtil.getConfigExtension(ORCA, config).publicKey;
    const feeTier = PDAUtil.getFeeTier(ORCA, config, SPACING);
    const instructions = [];
    if (!found.splashFeeTier) {
      if (!found.controlsFees) throw new TradeError(422, 'FEE_AUTHORITY_REQUIRED', 'That config has no Splash fee tier and this wallet is not its fee authority.');
      instructions.push(...ixs(WhirlpoolIx.initializeFeeTierIx(ctx.program, { whirlpoolsConfig: config, feeTierPda: feeTier, tickSpacing: SPACING, defaultFeeRate: feeRate, feeAuthority: wallet, funder: wallet })));
    }
    for (const address of found.missingBadges) {
      instructions.push(await ctx.program.methods.initializeTokenBadge().accounts({ whirlpoolsConfig: config, whirlpoolsConfigExtension: extension,
        tokenBadgeAuthority: wallet, tokenMint: key(address), tokenBadge: PDAUtil.getTokenBadge(ORCA, config, key(address)).publicKey, funder: wallet, systemProgram: SystemProgram.programId }).instruction());
    }
    if (!instructions.length) throw new TradeError(409, 'NOTHING_TO_DO', 'That config already has a Splash fee tier and the badges this pair needs. Initialize the pool.');
    const prepared = await packet(connection, wallet, instructions, 'Token badge and Splash fee tier');
    return { ...prepared, body: { ...base, ...prepared.public, config: config.toBase58(), feeTier: feeTier.publicKey.toBase58(), feeRateBps: found.splashFeeTier?.feeRateBps ?? feeRate, badges: found.missingBadges,
      message: `${found.missingBadges.length ? 'Issues the Orca token badge that lets a pool vault hold this Token-2022 mint' : 'Adds a Splash fee tier'}${!found.splashFeeTier && found.missingBadges.length ? ` and adds a ${feeRate / 100}% Splash fee tier` : ''} on a config you control. No tokens move.` } };
  }

  if (action === 'pool') {
    const config = key(body.config);
    if (!config) throw new TradeError(400, 'CONFIG_REQUIRED', 'Choose the Whirlpools config for this pool first.');
    const usable = await describeConfig(connection, config, wallet, pair.a, pair.b);
    if (!usable) throw new TradeError(422, 'CONFIG_UNAVAILABLE', 'That address is not a Whirlpools config.');
    if (usable.missingBadges.length) throw new TradeError(409, 'BADGE_REQUIRED', 'Issue the token badge on this config before initializing the pool.');
    const price = new Decimal(String(body.priceCounterPerMint || '0'));
    if (!price.isFinite() || price.lte(0)) throw new TradeError(400, 'INVALID_PRICE', 'Enter a starting price above zero.');
    const tokenBPerTokenA = pair.inverted ? new Decimal(1).div(price) : price;
    const sqrtPrice = PriceMath.priceToSqrtPriceX64(tokenBPerTokenA, pair.a.decimals, pair.b.decimals);
    const whirlpool = PDAUtil.getWhirlpool(ORCA, config, pair.tokenA, pair.tokenB, SPACING);
    const feeTier = PDAUtil.getFeeTier(ORCA, config, SPACING).publicKey;
    if (!await existingAccount(connection, feeTier)) throw new TradeError(409, 'FEE_TIER_MISSING', 'That config has no Splash fee tier. Run the badge step first.');
    if (await existingAccount(connection, whirlpool.publicKey)) throw new TradeError(409, 'POOL_EXISTS', 'This pool already exists. Open a position instead.');
    const vaultA = Keypair.generate(), vaultB = Keypair.generate();
    const instructions = ixs(WhirlpoolIx.initializePoolV2Ix(ctx.program, { initSqrtPrice: sqrtPrice, whirlpoolsConfig: config, whirlpoolPda: whirlpool,
      tokenMintA: pair.tokenA, tokenMintB: pair.tokenB, tokenBadgeA: PDAUtil.getTokenBadge(ORCA, config, pair.tokenA).publicKey, tokenBadgeB: PDAUtil.getTokenBadge(ORCA, config, pair.tokenB).publicKey,
      tokenProgramA: key(pair.a.tokenProgram), tokenProgramB: key(pair.b.tokenProgram), tokenVaultAKeypair: vaultA, tokenVaultBKeypair: vaultB, feeTierKey: feeTier, tickSpacing: SPACING, funder: wallet }));
    const [lower, upper] = TickUtil.getFullRangeTickIndex(SPACING);
    const starts = [...new Set([TickUtil.getStartTickIndex(lower, SPACING), TickUtil.getStartTickIndex(upper, SPACING)])];
    for (const startTick of starts) {
      instructions.push(...ixs(WhirlpoolIx.initTickArrayIx(ctx.program, { whirlpool: whirlpool.publicKey, tickArrayPda: PDAUtil.getTickArray(ORCA, whirlpool.publicKey, startTick), startTick, funder: wallet })));
    }
    const prepared = await packet(connection, wallet, instructions, 'Splash Pool initialization', [vaultA, vaultB]);
    return { ...prepared, body: { ...base, ...prepared.public, config: config.toBase58(), pool: whirlpool.publicKey.toBase58(), tickArrays: starts,
      priceCounterPerMint: price.toFixed(), priceTokenBPerTokenA: tokenBPerTokenA.toFixed(), initialTick: PriceMath.sqrtPriceX64ToTickIndex(sqrtPrice),
      message: `Initializes the pool at ${price.toFixed()} ${pair.counterInfo.symbol || 'counter'} per token${pair.inverted ? ` (stored by Orca as ${tokenBPerTokenA.toFixed()} token per counter because of address ordering)` : ''}, plus the two full-range tick arrays a Splash Pool needs. No tokens move yet.` } };
  }

  const poolAddress = key(body.pool);
  if (!poolAddress) throw new TradeError(400, 'POOL_REQUIRED', 'Select a pool.');
  const poolInfo = await connection.getAccountInfo(poolAddress, 'confirmed');
  const pool = poolInfo?.owner.equals(ORCA) ? ParsableWhirlpool.parse(poolAddress, poolInfo) : null;
  if (!pool || !pool.tokenMintA.equals(pair.tokenA) || !pool.tokenMintB.equals(pair.tokenB)) throw new TradeError(422, 'POOL_MISMATCH', 'That pool is not for this pair.');
  const extensionCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(ctx.fetcher, pair.tokenA, pair.tokenB);
  const ataA = getAssociatedTokenAddressSync(pair.tokenA, wallet, false, key(pair.a.tokenProgram));
  const ataB = getAssociatedTokenAddressSync(pair.tokenB, wallet, false, key(pair.b.tokenProgram));
  const solSide = pair.tokenA.equals(NATIVE_MINT) ? 'A' : pair.tokenB.equals(NATIVE_MINT) ? 'B' : null;
  const solAta = solSide === 'A' ? ataA : ataB;
  const solAtaExisted = solSide ? await existingAccount(connection, solAta) : true;
  const common = { whirlpool: poolAddress, tokenMintA: pair.tokenA, tokenMintB: pair.tokenB, tokenOwnerAccountA: ataA, tokenOwnerAccountB: ataB,
    tokenVaultA: pool.tokenVaultA, tokenVaultB: pool.tokenVaultB, tokenProgramA: key(pair.a.tokenProgram), tokenProgramB: key(pair.b.tokenProgram) };
  const amounts = (estA, estB) => ({ tokenA: { mint: pair.a.address, raw: estA.toString(), ui: ui(estA, pair.a.decimals) }, tokenB: { mint: pair.b.address, raw: estB.toString(), ui: ui(estB, pair.b.decimals) } });

  if (action === 'open' || action === 'increase') {
    const inputMint = key(body.inputMint), inputRaw = raw(body.inputRaw);
    if (!inputMint || !inputRaw || (!inputMint.equals(pair.tokenA) && !inputMint.equals(pair.tokenB))) throw new TradeError(400, 'INVALID_DEPOSIT', 'Enter a positive amount of one of the pair’s tokens.');
    let position, positionMint, positionTokenAccount, tickLowerIndex, tickUpperIndex, ephemeral = [], instructions = [];
    if (action === 'open') {
      [tickLowerIndex, tickUpperIndex] = TickUtil.getFullRangeTickIndex(pool.tickSpacing);
      const mintKeypair = Keypair.generate(); ephemeral = [mintKeypair]; positionMint = mintKeypair.publicKey;
      position = PDAUtil.getPosition(ORCA, positionMint).publicKey;
      positionTokenAccount = getAssociatedTokenAddressSync(positionMint, wallet, false, TOKEN_2022_PROGRAM_ID);
      instructions.push(...ixs(WhirlpoolIx.openPositionWithTokenExtensionsIx(ctx.program, { whirlpool: poolAddress, owner: wallet, positionPda: PDAUtil.getPosition(ORCA, positionMint),
        positionMint, positionTokenAccount, funder: wallet, tickLowerIndex, tickUpperIndex, withTokenMetadataExtension: true })));
    } else {
      const found = (await walletPositions(connection, ctx, wallet, poolAddress)).find((entry) => entry.address.toBase58() === body.position);
      if (!found) throw new TradeError(404, 'POSITION_NOT_FOUND', 'That position is not owned by this wallet in this pool.');
      position = found.address; positionMint = found.mint; positionTokenAccount = found.tokenAccount;
      tickLowerIndex = found.data.tickLowerIndex; tickUpperIndex = found.data.tickUpperIndex;
    }
    const tickArrayLower = PDAUtil.getTickArrayFromTickIndex(tickLowerIndex, pool.tickSpacing, poolAddress, ORCA).publicKey;
    const tickArrayUpper = PDAUtil.getTickArrayFromTickIndex(tickUpperIndex, pool.tickSpacing, poolAddress, ORCA).publicKey;
    for (const [tickArray, tick] of [[tickArrayLower, tickLowerIndex], [tickArrayUpper, tickUpperIndex]]) {
      if (!await existingAccount(connection, tickArray)) instructions.push(...ixs(WhirlpoolIx.initTickArrayIx(ctx.program, { whirlpool: poolAddress, tickArrayPda: PDAUtil.getTickArrayFromTickIndex(tick, pool.tickSpacing, poolAddress, ORCA), startTick: TickUtil.getStartTickIndex(tick, pool.tickSpacing), funder: wallet })));
    }
    const quote = increaseLiquidityQuoteByInputTokenWithParams({ inputTokenAmount: inputRaw, inputTokenMint: inputMint, tokenMintA: pair.tokenA, tokenMintB: pair.tokenB,
      tickCurrentIndex: pool.tickCurrentIndex, sqrtPrice: pool.sqrtPrice, tickLowerIndex, tickUpperIndex, tokenExtensionCtx: extensionCtx, slippageTolerance: slippage(slip) });
    if (quote.liquidityAmount.isZero()) throw new TradeError(400, 'AMOUNT_TOO_SMALL', 'That deposit is too small to mint any liquidity.');
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(wallet, ataA, wallet, pair.tokenA, key(pair.a.tokenProgram)),
      createAssociatedTokenAccountIdempotentInstruction(wallet, ataB, wallet, pair.tokenB, key(pair.b.tokenProgram)));
    if (solSide) instructions.push(...wrapSol(connection, wallet, solSide === 'A' ? quote.tokenMaxA : quote.tokenMaxB).before.slice(1));
    const hooks = await TokenExtensionUtil.getExtraAccountMetasForTransferHookForPool(connection, extensionCtx, ataA, pool.tokenVaultA, wallet, ataB, pool.tokenVaultB, wallet);
    instructions.push(...ixs(WhirlpoolIx.increaseLiquidityV2Ix(ctx.program, { ...common, position, positionTokenAccount, positionAuthority: wallet, tickArrayLower, tickArrayUpper,
      liquidityAmount: quote.liquidityAmount, tokenMaxA: quote.tokenMaxA, tokenMaxB: quote.tokenMaxB, ...hooks })));
    if (solSide && !solAtaExisted) instructions.push(createCloseAccountInstruction(solAta, wallet, wallet, [], TOKEN_PROGRAM_ID));
    const prepared = await packet(connection, wallet, instructions, action === 'open' ? 'Open position and deposit' : 'Increase liquidity', ephemeral);
    return { ...prepared, body: { ...base, ...prepared.public, pool: poolAddress.toBase58(), position: position.toBase58(), positionMint: positionMint.toBase58(),
      tickLowerIndex, tickUpperIndex, liquidity: quote.liquidityAmount.toString(), estimate: amounts(quote.tokenEstA, quote.tokenEstB), maximum: amounts(quote.tokenMaxA, quote.tokenMaxB), slippageBps: slip,
      message: `${action === 'open' ? 'Mints a position NFT covering the full price range and deposits' : 'Deposits'} about ${ui(quote.tokenEstA, pair.a.decimals)} ${pair.a.address === pair.mint.toBase58() ? 'tokens' : COUNTERS[pair.a.address] || 'A'} + ${ui(quote.tokenEstB, pair.b.decimals)} ${pair.b.address === pair.mint.toBase58() ? 'tokens' : COUNTERS[pair.b.address] || 'B'} at the current pool price. Never more than the maximums shown.` } };
  }

  if (['decrease', 'collect', 'close'].includes(action)) {
    const found = (await walletPositions(connection, ctx, wallet, poolAddress)).find((entry) => entry.address.toBase58() === body.position);
    if (!found) throw new TradeError(404, 'POSITION_NOT_FOUND', 'That position is not owned by this wallet in this pool.');
    const tickArrayLower = PDAUtil.getTickArrayFromTickIndex(found.data.tickLowerIndex, pool.tickSpacing, poolAddress, ORCA).publicKey;
    const tickArrayUpper = PDAUtil.getTickArrayFromTickIndex(found.data.tickUpperIndex, pool.tickSpacing, poolAddress, ORCA).publicKey;
    const hooks = await TokenExtensionUtil.getExtraAccountMetasForTransferHookForPool(connection, extensionCtx, pool.tokenVaultA, ataA, poolAddress, pool.tokenVaultB, ataB, poolAddress);
    const positional = { ...common, position: found.address, positionTokenAccount: found.tokenAccount, positionAuthority: wallet, ...hooks };
    const instructions = [createAssociatedTokenAccountIdempotentInstruction(wallet, ataA, wallet, pair.tokenA, key(pair.a.tokenProgram)),
      createAssociatedTokenAccountIdempotentInstruction(wallet, ataB, wallet, pair.tokenB, key(pair.b.tokenProgram))];
    let withdrawn = null;
    const bps = action === 'close' ? 10_000 : Number(body.percentBps);
    if (action !== 'collect') {
      if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) throw new TradeError(400, 'INVALID_PERCENT', 'Choose how much of the position to withdraw (1–100%).');
      const liquidity = found.data.liquidity.muln(bps).divn(10_000);
      if (liquidity.gtn(0)) {
        const quote = decreaseLiquidityQuoteByLiquidityWithParams({ liquidity, tickCurrentIndex: pool.tickCurrentIndex, sqrtPrice: pool.sqrtPrice,
          tickLowerIndex: found.data.tickLowerIndex, tickUpperIndex: found.data.tickUpperIndex, tokenExtensionCtx: extensionCtx, slippageTolerance: slippage(slip) });
        instructions.push(...ixs(WhirlpoolIx.decreaseLiquidityV2Ix(ctx.program, { ...positional, tickArrayLower, tickArrayUpper, liquidityAmount: quote.liquidityAmount, tokenMinA: quote.tokenMinA, tokenMinB: quote.tokenMinB })));
        withdrawn = { liquidity: quote.liquidityAmount.toString(), estimate: amounts(quote.tokenEstA, quote.tokenEstB), minimum: amounts(quote.tokenMinA, quote.tokenMinB) };
      } else if (action === 'decrease') throw new TradeError(400, 'NOTHING_TO_WITHDRAW', 'This position has no liquidity left.');
    }
    if (found.data.liquidity.gtn(0)) instructions.push(...ixs(WhirlpoolIx.updateFeesAndRewardsIx(ctx.program, { whirlpool: poolAddress, position: found.address, tickArrayLower, tickArrayUpper })));
    instructions.push(...ixs(WhirlpoolIx.collectFeesV2Ix(ctx.program, positional)));
    if (action === 'close') instructions.push(...ixs(WhirlpoolIx.closePositionWithTokenExtensionsIx(ctx.program, { receiver: wallet, position: found.address, positionMint: found.mint, positionTokenAccount: found.tokenAccount, positionAuthority: wallet })));
    if (solSide && !solAtaExisted) instructions.push(createCloseAccountInstruction(solAta, wallet, wallet, [], TOKEN_PROGRAM_ID));
    const prepared = await packet(connection, wallet, instructions, { decrease: 'Withdraw liquidity', collect: 'Collect fees', close: 'Close position' }[action]);
    return { ...prepared, body: { ...base, ...prepared.public, pool: poolAddress.toBase58(), position: found.address.toBase58(), percentBps: action === 'collect' ? 0 : bps, withdrawn, slippageBps: slip,
      feesOwed: amounts(found.data.feeOwedA, found.data.feeOwedB),
      message: { decrease: `Withdraws ${bps / 100}% of the position’s liquidity to your wallet and collects earned fees.`, collect: 'Collects the fees this position has earned so far. Liquidity stays in the pool.',
        close: 'Withdraws everything, collects fees, burns the position NFT, and refunds its rent.' }[action] } };
  }
  throw new TradeError(400, 'INVALID_ACTION', 'Unknown liquidity step.');
}

export function mountLiquidity(app, connection, receipts, limits) {
  app.get('/api/trader/liquidity/overview', limits.readLimit, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try { response.json(await liquidityOverview(connection, request.query)); } catch (error) { fail(response, error); }
  });
  app.post('/api/trader/liquidity/prepare', limits.prepareLimit, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      const result = await prepareLiquidity(connection, request.body || {});
      const { transaction, ...record } = result.body;
      const preparationToken = receipts.issue(result.tx, { engine: 'liquidity', stage: record.stage, buyer: record.wallet, mint: record.mint, counter: record.counter,
        config: record.config || null, pool: record.pool || null, position: record.position || null });
      response.json({ ...result.body, preparationToken });
    } catch (error) { fail(response, error); }
  });
  app.post('/api/trader/liquidity/submit', limits.submitLimit, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      const record = receipts.read(request.body?.preparationToken);
      if (record.engine !== 'liquidity') throw new TradeError(400, 'WRONG_ENGINE', 'This receipt is not for a liquidity step.');
      const tx = decodeSignedTransaction(request.body?.signedTransaction);
      verifyBuyerSigned(tx, record);
      const simulation = await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
      if (simulation.value.err) {
        const logs = simulation.value.logs || [];
        if (logs.some((line) => line.includes('existing holders only'))) throw new TradeError(409, 'HOLDER_GATE', 'The mint’s hook rejected a transfer: the receiving account must already hold this mint.');
        if (logs.some((line) => /TokenMaxExceeded|TokenMinSubceeded/.test(line))) throw new TradeError(409, 'PRICE_MOVED', 'The pool price moved past your slippage. Refresh and try again.');
        throw new TradeError(409, 'SIGNED_SIMULATION_FAILED', `This step no longer executes: ${logs.filter((line) => line.includes('Error') || line.includes('failed')).slice(-2).join(' ') || 'simulation failed'}. Nothing was submitted.`);
      }
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
      response.json({ signature, stage: record.stage, config: record.config, pool: record.pool, position: record.position });
    } catch (error) { fail(response, error); }
  });
}

import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  ExtensionType,
  NATIVE_MINT_2022,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getDefaultAccountState,
  getExtensionData,
  getExtensionTypes,
  getExtraAccountMetaAddress,
  getExtraAccountMetas,
  getMetadataPointerState,
  getTransferHook,
  unpackMint,
} from '@solana/spl-token';
import { unpack as unpackTokenMetadata } from '@solana/spl-token-metadata';
import { CONTROLLER, MINTS, WHIRLPOOL_PROGRAM, WSOL } from './hook-market-mints.js';
import { mountDirectBuy } from './direct-buy.js';
import { mountPoolReadout } from './pool-readout.js';
import { mountCaptainTrader } from './captain-trader.js';
import { rateLimit } from './rate-limit.js';

const EXECUTE_DISCRIMINATOR = Buffer.from([105, 37, 101, 197, 75, 251, 102, 26]);
const TOKEN_BADGE_DISCRIMINATOR = Buffer.from([116, 219, 204, 229, 249, 116, 255, 150]);
const FEE_TIER_DISCRIMINATOR = Buffer.from([56, 75, 159, 76, 142, 68, 190, 105]);
const CONFIG_DISCRIMINATOR = Buffer.from([157, 20, 49, 224, 217, 87, 193, 254]);
const CHAIN = 'mainnet-beta';
const PROGRAM = new PublicKey(WHIRLPOOL_PROGRAM);
const THOOOK_PROGRAM = new PublicKey('VwcGiFProGtfYLKsDpJuxZoYMFZpuZ1XT6MGmBd9AwU');
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const WSOL_KEY = new PublicKey(WSOL);
const STATUS_SIZE = 133;
const MINT_BY_ADDRESS = new Map(MINTS.map((entry) => [entry.mint, entry]));
const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');

function pubkey(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return null;
  try { return new PublicKey(value); } catch { return null; }
}

function keyString(value) {
  if (!value || value.equals(PublicKey.default)) return null;
  return value.toBase58();
}

function accountMatches(info, discriminator, minimumBytes) {
  return Boolean(info && info.owner.equals(PROGRAM) && info.data.length >= minimumBytes &&
    info.data.subarray(0, 8).equals(discriminator));
}

function programDataAddress(info) {
  if (!info?.executable || !info.owner.equals(UPGRADEABLE_LOADER)) return null;
  if (info.data.length < 36 || info.data.readUInt32LE(0) !== 2) return null;
  return new PublicKey(info.data.subarray(4, 36));
}

function programDataReady(info) {
  return Boolean(info && info.owner.equals(UPGRADEABLE_LOADER) &&
    info.data.length > 45 && info.data.readUInt32LE(0) === 3);
}

async function runnableProgram(connection, info) {
  if (!info?.executable) return false;
  if (!info.owner.equals(UPGRADEABLE_LOADER)) return true;
  const address = programDataAddress(info);
  return address ? programDataReady(await connection.getAccountInfo(address, 'confirmed')) : false;
}

function deriveBadge(config, mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('token_badge'), config.toBuffer(), mint.toBuffer()], PROGRAM,
  )[0];
}

function deriveFeeTier(config, tickSpacing) {
  const index = Buffer.alloc(2);
  index.writeUInt16LE(tickSpacing);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_tier'), config.toBuffer(), index], PROGRAM,
  )[0];
}

function derivePool(config, mintA, mintB, tickSpacing) {
  const index = Buffer.alloc(2);
  index.writeUInt16LE(tickSpacing);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('whirlpool'), config.toBuffer(), mintA.toBuffer(), mintB.toBuffer(), index], PROGRAM,
  )[0];
}

function orderedMints(a, b) {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
}

function badgeVerified(info, config, mint) {
  return accountMatches(info, TOKEN_BADGE_DISCRIMINATOR, 73) &&
    info.data.subarray(8, 40).equals(config.toBuffer()) &&
    info.data.subarray(40, 72).equals(mint.toBuffer());
}

function feeTierVerified(info, config, tickSpacing) {
  return accountMatches(info, FEE_TIER_DISCRIMINATOR, 44) &&
    info.data.subarray(8, 40).equals(config.toBuffer()) &&
    info.data.readUInt16LE(40) === tickSpacing;
}

function eamlVerified(info, programId) {
  if (!info || !info.owner.equals(programId) || info.data.length < 16 ||
      !info.data.subarray(0, 8).equals(EXECUTE_DISCRIMINATOR)) return false;
  const bodyLength = info.data.readUInt32LE(8);
  const count = info.data.readUInt32LE(12);
  if (bodyLength !== 4 + count * 35 || info.data.length < 12 + bodyLength) return false;
  try { return getExtraAccountMetas(info).length === count; } catch { return false; }
}

function tokenMetadata(mint) {
  try {
    const data = getExtensionData(ExtensionType.TokenMetadata, mint.tlvData);
    if (!data) return null;
    const decoded = unpackTokenMetadata(data);
    return {
      name: decoded.name,
      symbol: decoded.symbol,
      uri: decoded.uri,
      updateAuthority: keyString(decoded.updateAuthority),
    };
  } catch { return null; }
}

// Mirrors the mint-extension gate in Orca Whirlpool's V2 token helper. Unknown
// extension types are rejected here so a read-only preflight cannot overstate
// pool eligibility after a Token-2022 program upgrade.
function orcaSupportsMint(mint, isToken2022, hasBadge, address) {
  if (!isToken2022) return true;
  if (address.equals(NATIVE_MINT_2022) || (mint.freezeAuthority && !hasBadge)) return false;
  const unconditionallySupported = new Set([
    ExtensionType.TransferFeeConfig,
    ExtensionType.InterestBearingConfig,
    ExtensionType.TokenMetadata,
    ExtensionType.MetadataPointer,
    ExtensionType.ScaledUiAmountConfig,
    ExtensionType.ConfidentialTransferMint,
  ]);
  const badgeSupported = new Set([
    ExtensionType.PermanentDelegate,
    ExtensionType.TransferHook,
    ExtensionType.MintCloseAuthority,
    ExtensionType.DefaultAccountState,
    ExtensionType.PausableConfig,
  ]);
  for (const extension of getExtensionTypes(mint.tlvData)) {
    if (unconditionallySupported.has(extension)) continue;
    if (!badgeSupported.has(extension) || !hasBadge) return false;
    if (extension === ExtensionType.DefaultAccountState &&
        getDefaultAccountState(mint)?.state !== 1 && !mint.freezeAuthority) return false;
  }
  return true;
}

async function getInfos(connection, addresses) {
  return connection.getMultipleAccountsInfo(addresses, 'confirmed');
}

function emptyListing(entry) {
  // Simulation evidence is historical. The config, fee tier, badge, and pool
  // availability fields below are rechecked on each request.
  return {
    mint: entry.mint,
    status: 'unavailable',
    hookExtensionVerified: false,
    hookAuthority: null,
    hookProgram: null,
    authorityVerified: false,
    mintable: false,
    mintAuthorityControlled: false,
    mintAuthority: null,
    metadata: null,
    metadataPointer: null,
    metadataUpdateAuthority: null,
    config: entry.config,
    orcaConfig: entry.config,
    badgeConfig: entry.config,
    configVerified: false,
    badge: entry.badge,
    badgeVerified: false,
    tickSpacing: entry.tickSpacing,
    feeTier: entry.feeTier,
    feeTierVerified: false,
    defaultFeeRate: null,
    wsolPool: entry.wsolPool,
    wsolPoolFree: null,
    poolInitializationSimulated: true,
    poolSimulationAuditedAt: '2026-10-06',
    poolSimulationQuoteMint: WSOL,
    poolSimulation: 'WSOL initialize_pool_v2 simulation passed on mainnet on 2026-10-06; no Orca or Jupiter routing was verified.',
    currentEaml: null,
    currentEamlVerified: false,
    currentHookProgramExecutable: false,
    currentHookProgramRunnable: false,
    currentHookProgramData: null,
    hookRentVault: null,
    hookRentVaultLamports: null,
    hookStatusRentLamports: null,
    hookStatusesAffordable: null,
    price: null,
    paymentMint: null,
    paymentSymbol: null,
    paymentRecipient: null,
    error: null,
  };
}

async function inspectEntries(connection, entries) {
  const addresses = [];
  const planned = entries.map((entry) => {
    const mint = new PublicKey(entry.mint);
    const config = new PublicKey(entry.config);
    const [a, b] = orderedMints(mint, WSOL_KEY);
    const badge = deriveBadge(config, mint);
    const feeTier = deriveFeeTier(config, entry.tickSpacing);
    const pool = derivePool(config, a, b, entry.tickSpacing);
    const offset = addresses.length;
    addresses.push(mint, config, badge, feeTier, pool);
    return { entry, mint, config, badge, feeTier, pool, offset };
  });
  const infos = await getInfos(connection, addresses);
  const eamlPlans = [];
  const listings = planned.map(({ entry, mint, config, badge, feeTier, pool, offset }) => {
    const result = emptyListing(entry);
    const [mintInfo, configInfo, badgeInfo, feeTierInfo, poolInfo] = infos.slice(offset, offset + 5);
    result.configVerified = accountMatches(configInfo, CONFIG_DISCRIMINATOR, 108);
    result.badgeVerified = badge.toBase58() === entry.badge && badgeVerified(badgeInfo, config, mint);
    result.feeTierVerified = feeTier.toBase58() === entry.feeTier && feeTierVerified(feeTierInfo, config, entry.tickSpacing);
    result.defaultFeeRate = result.feeTierVerified ? feeTierInfo.data.readUInt16LE(42) : null;
    result.wsolPoolFree = pool.toBase58() === entry.wsolPool && poolInfo === null;
    if (!mintInfo) { result.error = 'Mint account is absent.'; return result; }
    if (!mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      result.error = 'Mint is not owned by Token-2022.';
      return result;
    }
    try {
      const decoded = unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID);
      result.mintAuthority = keyString(decoded.mintAuthority);
      result.mintAuthorityControlled = result.mintAuthority === CONTROLLER;
      result.mintable = result.mintAuthorityControlled;
      result.metadata = tokenMetadata(decoded);
      result.metadataUpdateAuthority = result.metadata?.updateAuthority || null;
      const pointer = getMetadataPointerState(decoded);
      result.metadataPointer = pointer ? {
        address: keyString(pointer.metadataAddress),
        authority: keyString(pointer.authority),
      } : null;
      const hook = getTransferHook(decoded);
      result.hookExtensionVerified = hook !== null;
      result.hookAuthority = keyString(hook?.authority);
      result.hookProgram = keyString(hook?.programId);
      result.authorityVerified = result.hookAuthority === CONTROLLER;
      if (result.hookProgram) {
        const programId = new PublicKey(result.hookProgram);
        result.currentEaml = getExtraAccountMetaAddress(mint, programId).toBase58();
        eamlPlans.push({ result, programId, address: new PublicKey(result.currentEaml) });
      }
      result.status = result.hookExtensionVerified && result.authorityVerified ? 'candidate' : 'unavailable';
    } catch (error) {
      result.error = `Could not decode Token-2022 mint: ${error.message}`;
    }
    return result;
  });
  if (eamlPlans.length) {
    const hookAccounts = await getInfos(connection, eamlPlans.flatMap((plan) => [plan.programId, plan.address]));
    const programDataPlans = eamlPlans.flatMap((plan, i) => {
      const address = programDataAddress(hookAccounts[i * 2]);
      if (!address) return [];
      plan.result.currentHookProgramData = address.toBase58();
      return [{ plan, address }];
    });
    const programDataInfos = programDataPlans.length ?
      await getInfos(connection, programDataPlans.map((plan) => plan.address)) : [];
    const readyData = new Set(programDataPlans.filter((_, i) =>
      programDataReady(programDataInfos[i])).map((plan) => plan.address.toBase58()));
    eamlPlans.forEach((plan, i) => {
      const programInfo = hookAccounts[i * 2];
      plan.result.currentHookProgramExecutable = Boolean(programInfo?.executable);
      plan.result.currentHookProgramRunnable = Boolean(programInfo?.executable && (
        !programInfo.owner.equals(UPGRADEABLE_LOADER) ||
        (plan.result.currentHookProgramData && readyData.has(plan.result.currentHookProgramData))
      ));
      plan.result.currentEamlVerified = eamlVerified(hookAccounts[i * 2 + 1], plan.programId);
    });
  }
  const rentPlans = listings.filter((result) => result.hookProgram === THOOOK_PROGRAM.toBase58()).map((result) => {
    const mint = new PublicKey(result.mint);
    const address = PublicKey.findProgramAddressSync(
      [Buffer.from('rent-vault'), mint.toBuffer()], THOOOK_PROGRAM,
    )[0];
    result.hookRentVault = address.toBase58();
    return { result, address };
  });
  if (rentPlans.length) {
    const [vaultInfos, rentLamports] = await Promise.all([
      getInfos(connection, rentPlans.map((plan) => plan.address)),
      connection.getMinimumBalanceForRentExemption(STATUS_SIZE, 'confirmed'),
    ]);
    rentPlans.forEach(({ result }, i) => {
      const vault = vaultInfos[i];
      if (!vault || !vault.owner.equals(PublicKey.default) || vault.data.length !== 0) return;
      result.hookRentVaultLamports = vault.lamports;
      result.hookStatusRentLamports = rentLamports;
      result.hookStatusesAffordable = Math.floor(vault.lamports / rentLamports);
    });
  }
  return listings;
}

async function inspectPoolProposal(connection, listing, proposal) {
  const checks = [];
  if (!proposal) return checks;
  const quote = pubkey(proposal.quoteMint);
  const tickSpacing = Number(proposal.tickSpacing);
  const initialPrice = String(proposal.initialPrice ?? '');
  if (!quote || quote.toBase58() === listing.mint ||
      !Number.isSafeInteger(tickSpacing) || tickSpacing < 1 || tickSpacing > 65535 ||
      !/^\d+(\.\d+)?$/.test(initialPrice) || Number(initialPrice) <= 0) {
    checks.push({ label: 'Whirlpool inputs', ok: false, detail: 'Provide a different valid quote mint, a u16 tick spacing, and a positive initial price.' });
    return checks;
  }
  const config = new PublicKey(listing.config);
  const mint = new PublicKey(listing.mint);
  const badge = deriveBadge(config, quote);
  const feeTier = deriveFeeTier(config, tickSpacing);
  const [a, b] = orderedMints(mint, quote);
  const pool = derivePool(config, a, b, tickSpacing);
  const [quoteInfo, quoteBadgeInfo, tierInfo, poolInfo] = await getInfos(connection, [quote, badge, feeTier, pool]);
  let quoteValid = false;
  let quoteHasBadge = false;
  let quoteEligible = false;
  if (quoteInfo && (quoteInfo.owner.equals(TOKEN_PROGRAM_ID) || quoteInfo.owner.equals(TOKEN_2022_PROGRAM_ID))) {
    try {
      const decoded = unpackMint(quote, quoteInfo, quoteInfo.owner);
      quoteValid = decoded.isInitialized;
      quoteHasBadge = badgeVerified(quoteBadgeInfo, config, quote);
      quoteEligible = quoteValid && orcaSupportsMint(decoded, quoteInfo.owner.equals(TOKEN_2022_PROGRAM_ID), quoteHasBadge, quote);
    } catch { /* malformed mint */ }
  }
  checks.push({ label: 'Quote mint', ok: quoteValid, detail: quoteValid ? quote.toBase58() : 'The quote address is not an initialized SPL mint.' });
  checks.push({ label: 'Orca quote eligibility', ok: quoteEligible,
    detail: quoteInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) ?
      `Token-2022 extensions checked; badge ${quoteHasBadge ? 'present' : 'absent'} at ${badge.toBase58()}` :
      'Classic SPL Token mint required, or supported Token-2022 extensions.' });
  checks.push({ label: 'Fee tier', ok: feeTierVerified(tierInfo, config, tickSpacing), detail: feeTier.toBase58() });
  checks.push({ label: 'New pool address', ok: poolInfo === null, detail: pool.toBase58() });
  checks.push({ label: 'Pool initialization simulation', ok: false, detail: 'A complete initialize_pool_v2 transaction has not been simulated for this proposal.' });
  return checks;
}

function check(label, ok, detail) { return { label, ok: Boolean(ok), detail }; }

export function createHookMarketApp(connection) {
  const app = express();
  let listingCache = null;
  let listingFetch = null;
  const liveListings = async () => {
    if (listingCache && Date.now() - listingCache.checkedAtMs < 15_000) return listingCache.payload;
    if (listingFetch) return listingFetch;
    listingFetch = inspectEntries(connection, MINTS).then((listings) => {
      const checkedAtMs = Date.now();
      listingCache = { checkedAtMs, payload: { chain: CHAIN, checkedAt: new Date(checkedAtMs).toISOString(), listings } };
      return listingCache.payload;
    }).finally(() => { listingFetch = null; });
    return listingFetch;
  };
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(compression());
  app.use(express.json({ limit: '16kb' }));
  app.use(['/api/trader', '/api/swap/status'], (request, response, next) => {
    const origin = request.get('Origin');
    if (['https://captainhook.fun', 'https://www.captainhook.fun', 'https://hooksare.fun',
      'https://www.hooksare.fun', 'https://hooksare-fun.fly.dev',
      'https://thoook-terminal.fly.dev', 'http://localhost:3000'].includes(origin)) {
      response.set('Vary', 'Origin');
      response.set('Access-Control-Allow-Origin', origin);
      response.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.set('Access-Control-Allow-Headers', 'Content-Type');
      if (request.method === 'OPTIONS') return response.sendStatus(204);
    }
    next();
  });
  app.get('/outbreak-map.html', (_request, response) => response.redirect(308, 'https://captainhook.fun/'));
  app.get('/api/health', (_request, response) => response.json({ ok: true, chain: CHAIN, mode: 'captainhook-router-auctions', brand: 'Captain Hook' }));
  // Swap quotes simulate transactions; preflight and status also hit mainnet RPC.
  // Bound each route before its handler, including the status route mounted below.
  app.use('/api/swap/prepare', rateLimit({ perIp: 8, global: 48 }));
  app.use('/api/swap/status', rateLimit({ perIp: 90, global: 240 }));
  app.use('/api/hook-market/preflight', rateLimit({ perIp: 8, global: 24 }));
  mountDirectBuy(app, connection);
  mountPoolReadout(app, connection);
  mountCaptainTrader(app, connection);

  app.get('/api/hook-market/listings', async (_request, response) => {
    try {
      const payload = await liveListings();
      response.set('Cache-Control', 'no-store');
      response.json(payload);
    } catch {
      console.error('[hook-market] listing check failed');
      response.status(503).json({ error: 'Mainnet inventory could not be verified. Try again shortly.' });
    }
  });

  app.post('/api/hook-market/preflight', async (request, response) => {
    const { mint, programId, buyer, metadata, whirlpool } = request.body || {};
    const entry = MINT_BY_ADDRESS.get(mint);
    const proposedProgram = pubkey(programId);
    if (!entry || !proposedProgram || (buyer != null && !pubkey(buyer)) ||
        (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata))) ||
        (whirlpool != null && (typeof whirlpool !== 'object' || Array.isArray(whirlpool)))) {
      return response.status(400).json({ error: 'Invalid mint, program, wallet, or optional proposal.' });
    }
    try {
      const listing = (await inspectEntries(connection, [entry]))[0];
      const eamlAddress = getExtraAccountMetaAddress(new PublicKey(mint), proposedProgram);
      const [programInfo, eamlInfo] = await getInfos(connection, [proposedProgram, eamlAddress]);
      const programExecutable = await runnableProgram(connection, programInfo);
      const eamlReady = eamlVerified(eamlInfo, proposedProgram);
      const checks = [
        check('Token-2022 TransferHook extension', listing.hookExtensionVerified, mint),
        check('Retained hook authority', listing.authorityVerified, listing.hookAuthority || 'No active hook authority'),
        check('Proposed hook program', programExecutable, programExecutable ? 'Runnable on mainnet' : 'Program is absent, not executable, or its ProgramData is closed'),
        check('Proposed ExtraAccountMetaList', eamlReady, eamlAddress.toBase58()),
        check('Orca config', listing.configVerified, listing.config),
        check('Base token badge', listing.badgeVerified, listing.badge),
      ];
      if (metadata) {
        const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
        const uri = typeof metadata.uri === 'string' ? metadata.uri.trim() : '';
        const valid = name.length > 0 && name.length <= 128 && /^https?:\/\//.test(uri) && uri.length <= 512;
        checks.push(check('Metadata inputs', valid, valid ? 'Name and URI are well formed.' : 'Provide a name and HTTP(S) URI.'));
        checks.push(check('Metadata update authority', listing.metadataUpdateAuthority === CONTROLLER,
          listing.metadataUpdateAuthority || 'No self-hosted Token-2022 metadata update authority verified'));
      }
      checks.push(...await inspectPoolProposal(connection, listing, whirlpool));
      checks.push(check('Published sale terms', false, 'Per-mint price, payment token, and recipient have not been supplied.'));
      checks.push(check('Retained-authority co-sign', false, 'Buyer and 331n authority transaction assembly is not configured.'));
      response.set('Cache-Control', 'no-store');
      response.json({
        chain: CHAIN,
        checkedAt: new Date().toISOString(),
        mint,
        proposedProgram: proposedProgram.toBase58(),
        eamlAddress: eamlAddress.toBase58(),
        ready: false,
        message: 'This is a read-only mainnet preflight. Sale terms and the retained authority co-sign flow are pending.',
        checks,
      });
    } catch {
      console.error('[hook-market] preflight failed');
      response.status(503).json({ error: 'Mainnet preflight could not be completed. Try again shortly.' });
    }
  });

  app.get('/index.html', (_request, response) => response.redirect(308, 'https://captainhook.fun/'));
  app.get('/', (request, response, next) => {
    if (request.hostname === 'thoook.fly.dev') return response.redirect(308, 'https://captainhook.fun/');
    next();
  });
  app.use(express.static(frontendDir, { index: 'project.html', maxAge: '5m' }));
  app.use('/api', (_request, response) => response.status(404).json({ error: 'Unknown API route.' }));
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.RPC_URL) throw new Error('RPC_URL is required for live mainnet verification.');
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const connection = new Connection(process.env.RPC_URL, { commitment: 'confirmed' });
  createHookMarketApp(connection).listen(port, () => console.log(`[thoook] listening on :${port}`));
}

export { inspectEntries, eamlVerified, deriveBadge, deriveFeeTier, derivePool };

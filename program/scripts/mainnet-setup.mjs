/** Mainnet THOOOK setup + signed checked-transfer smoke. Default mode is read-only. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
} = require('@solana/web3.js');
const {
  TOKEN_2022_PROGRAM_ID, getMint, getTransferHook, getAccount,
  createUpdateTransferHookInstruction,
  createTransferCheckedWithTransferHookInstruction,
} = require('@solana/spl-token');

const PROGRAM_ID = new PublicKey('VwcGiFProGtfYLKsDpJuxZoYMFZpuZ1XT6MGmBd9AwU');
const ADMIN_ID = new PublicKey('331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth');
const EXPECTED_SO_SHA256 = '7dc22ef97eae3183722bbb757ff90a1069d8553933acaa68f70a72b929ba73e2';
const SEND = process.argv.includes('--send');
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
};
const pubkey = (name) => new PublicKey(env(name));
const amount = (name) => {
  const value = BigInt(env(name));
  if (value <= 0n || value > (1n << 64n) - 1n) throw new Error(`${name} must be a positive u64`);
  return value;
};
const le64 = (n) => { const out = Buffer.alloc(8); out.writeBigUInt64LE(n); return out; };
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const ix = (tag, keys, args = Buffer.alloc(0)) => ({
  programId: PROGRAM_ID, keys, data: Buffer.concat([Buffer.from([tag]), args]),
});
const pda = (seed, mint) => PublicKey.findProgramAddressSync([
  Buffer.from(seed), mint.toBuffer(),
], PROGRAM_ID)[0];
const requireEqual = (actual, expected, what) => {
  if (!actual.equals(expected)) throw new Error(`${what}: expected ${expected}, got ${actual}`);
};
const readKeypair = (path, expected, what) => {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const signer = Keypair.fromSecretKey(Uint8Array.from(parsed));
  requireEqual(signer.publicKey, expected, what);
  return signer;
};
const programDir = fileURLToPath(new URL('..', import.meta.url));
const soFile = resolve(programDir, 'target/deploy/thoook.so');
const soHash = createHash('sha256').update(readFileSync(soFile)).digest('hex');
if (soHash !== EXPECTED_SO_SHA256) throw new Error(`SBF artifact hash mismatch: ${soHash}`);

const handoff = readFileSync(env('HANDOFF_PATH'), 'utf8');
const rpc = handoff.match(/https:\/\/mainnet\.helius-rpc\.com\/\?api-key=[^\s)`"'<>]+/)?.[0];
if (!rpc) throw new Error('HANDOFF_PATH has no mainnet Helius RPC URL');
const redact = (value) => String(value).replaceAll(rpc, '[MAINNET_RPC_URL]');
process.on('uncaughtException', (error) => {
  console.error(redact(error?.stack || error));
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error(redact(error?.stack || error));
  process.exit(1);
});
const connection = new Connection(rpc, 'confirmed');
const mint = pubkey('MINT');
const patientZero = pubkey('PATIENT_ZERO');
const prizeWallet = pubkey('PRIZE_WALLET');
const poolOwners = env('POOL_OWNERS').split(',').map((x) => new PublicKey(x.trim()));
if (poolOwners.length < 1 || poolOwners.length > 16 ||
    new Set(poolOwners.map((x) => x.toBase58())).size !== poolOwners.length) {
  throw new Error('POOL_OWNERS must contain 1–16 distinct token-vault owner public keys');
}
const minInfect = amount('MIN_INFECT_RAW');
const vaxBurn = amount('VAX_BURN_RAW');
const minActiveHold = amount('MIN_ACTIVE_HOLD_RAW');
const vaultTarget = amount('RENT_VAULT_LAMPORTS');
const smokeSource = pubkey('SMOKE_SOURCE');
const smokeDestination = pubkey('SMOKE_DESTINATION');
const smokeOwner = pubkey('SMOKE_OWNER');
const smokeAmount = amount('SMOKE_AMOUNT_RAW');
const config = pda('config', mint);
const eaml = pda('extra-account-metas', mint);
const vault = pda('rent-vault', mint);

console.log(JSON.stringify({
  mode: SEND ? 'SEND MAINNET TRANSACTIONS' : 'READ-ONLY PREFLIGHT',
  soFile, soHash, programId: PROGRAM_ID.toBase58(), mint: mint.toBase58(),
  admin: ADMIN_ID.toBase58(), config: config.toBase58(), eaml: eaml.toBase58(),
  vault: vault.toBase58(), poolOwners: poolOwners.map((x) => x.toBase58()),
  smokeSource: smokeSource.toBase58(), smokeDestination: smokeDestination.toBase58(),
  smokeOwner: smokeOwner.toBase58(), smokeAmount: smokeAmount.toString(),
}, null, 2));

// Complete all independent read-only checks before loading a secret key or sending anything.
const [programInfo, mintInfo, configInfo, eamlInfo, vaultInfo, source, destination] = await Promise.all([
  connection.getAccountInfo(PROGRAM_ID, 'confirmed'),
  getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID),
  connection.getAccountInfo(config, 'confirmed'),
  connection.getAccountInfo(eaml, 'confirmed'),
  connection.getAccountInfo(vault, 'confirmed'),
  getAccount(connection, smokeSource, 'confirmed', TOKEN_2022_PROGRAM_ID),
  getAccount(connection, smokeDestination, 'confirmed', TOKEN_2022_PROGRAM_ID),
]);
if (!programInfo?.executable) throw new Error('THOOOK program is not deployed/executable');
const hook = getTransferHook(mintInfo);
if (!hook) throw new Error('Mint has no TransferHook extension');
requireEqual(hook.authority, ADMIN_ID, 'Mint TransferHook authority');
requireEqual(source.mint, mint, 'Smoke source mint');
requireEqual(destination.mint, mint, 'Smoke destination mint');
requireEqual(source.owner, smokeOwner, 'Smoke source owner');
if (source.amount < smokeAmount) throw new Error('Smoke source lacks tokens');
if (smokeSource.equals(smokeDestination)) throw new Error('Smoke source and destination must differ');
const rent = await connection.getMinimumBalanceForRentExemption(133, 'confirmed');
if (vaultTarget < BigInt(rent)) throw new Error('RENT_VAULT_LAMPORTS must cover at least one 133-byte status');
if (configInfo && (!configInfo.owner.equals(PROGRAM_ID) ||
    configInfo.data.length !== 673 || configInfo.data.subarray(0, 8).toString() !== 'THOOKCFG' ||
    !configInfo.data.subarray(8, 40).equals(mint.toBuffer()) ||
    !configInfo.data.subarray(40, 72).equals(ADMIN_ID.toBuffer()))) {
  throw new Error('Existing config PDA has unexpected owner or bytes');
}
if (eamlInfo && !eamlInfo.owner.equals(PROGRAM_ID)) throw new Error('EAML PDA owner mismatch');
if (vaultInfo && (!vaultInfo.owner.equals(SystemProgram.programId) || vaultInfo.data.length !== 0)) {
  throw new Error('Rent vault PDA is not an empty system account');
}
let currentPools = [];
if (configInfo) {
  const data = configInfo.data;
  if (!data.subarray(72, 104).equals(patientZero.toBuffer()) ||
      !data.subarray(104, 136).equals(prizeWallet.toBuffer()) ||
      data.readBigUInt64LE(136) !== minInfect || data.readBigUInt64LE(144) !== vaxBurn ||
      data.readBigUInt64LE(152) !== minActiveHold) {
    throw new Error('Existing config terms differ from the requested values');
  }
  const poolCount = data[160];
  if (poolCount > 16) throw new Error('Existing pool count invalid');
  currentPools = Array.from({ length: poolCount }, (_, i) => new PublicKey(data.subarray(161 + i * 32, 193 + i * 32)));
}
const mergedPools = [...currentPools];
for (const owner of poolOwners) {
  if (!mergedPools.some((x) => x.equals(owner))) mergedPools.push(owner);
}
if (mergedPools.length > 16) throw new Error('Merged pool allowlist exceeds 16 entries');
console.log(`Preflight passed. Mint decimals=${mintInfo.decimals}; hook=${hook.programId?.toBase58()}; status rent=${rent}; vault=${vaultInfo?.lamports ?? 0} lamports.`);
console.log(`Planned: ${configInfo ? 'keep config' : 'create config'}, ${eamlInfo ? 'keep EAML' : 'create EAML'}, ${mergedPools.length === currentPools.length ? 'keep' : 'update'} pool owners, fund vault to >=${vaultTarget}, ${hook.programId?.equals(PROGRAM_ID) ? 'keep' : 'update'} hook pointer, checked-transfer smoke.`);
if (!SEND) {
  console.log('Read-only preflight complete. Run with --send after reviewing the plan.');
  process.exit(0);
}

const admin = readKeypair(env('ADMIN_KEYPAIR'), ADMIN_ID, 'Admin keypair');
const payer = process.env.FEE_PAYER_KEYPAIR
  ? readKeypair(process.env.FEE_PAYER_KEYPAIR, new PublicKey(env('FEE_PAYER_PUBKEY')), 'Fee payer keypair')
  : admin;
const ownerSigner = readKeypair(env('SMOKE_OWNER_KEYPAIR'), smokeOwner, 'Smoke owner keypair');
const signers = (...extra) => {
  const all = [payer, admin, ...extra];
  return [...new Map(all.map((x) => [x.publicKey.toBase58(), x])).values()];
};
async function simulateThenSend(instructions, txSigners, label) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash });
  transaction.add(...instructions);
  transaction.sign(...txSigners);
  // web3.js v1 accepts a config object only for VersionedTransaction; this
  // legacy Transaction overload takes an optional signer array instead.
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    console.error(`${label} simulation logs:`, simulation.value.logs);
    throw new Error(`${label} simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (result.value.err) throw new Error(`${label} failed: ${JSON.stringify(result.value.err)}`);
  console.log(`${label}: ${signature}`);
  return signature;
}
const adminMeta = meta(admin.publicKey, true, true);
if (!configInfo) {
  const args = Buffer.concat([
    patientZero.toBuffer(), prizeWallet.toBuffer(), le64(minInfect), le64(vaxBurn), le64(minActiveHold),
    Buffer.from([poolOwners.length]), ...poolOwners.map((x) => x.toBuffer()),
  ]);
  await simulateThenSend([ix(0, [adminMeta, meta(mint), meta(config, true), meta(SystemProgram.programId)], args)], signers(), 'Initialize config');
}
if (!eamlInfo) {
  await simulateThenSend([ix(1, [adminMeta, meta(mint), meta(config), meta(eaml, true), meta(SystemProgram.programId)])], signers(), 'Initialize EAML');
}
if (configInfo && mergedPools.length !== currentPools.length) {
  const args = Buffer.concat([Buffer.from([mergedPools.length]), ...mergedPools.map((x) => x.toBuffer())]);
  await simulateThenSend([ix(3, [meta(admin.publicKey, false, true), meta(mint), meta(config, true)], args)], signers(), 'Update pool owners');
}
const vaultNow = (await connection.getAccountInfo(vault, 'confirmed'))?.lamports ?? 0;
if (BigInt(vaultNow) < vaultTarget) {
  const topUp = vaultTarget - BigInt(vaultNow);
  if (topUp > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Vault top-up exceeds JS safe integer');
  await simulateThenSend([ix(2, [
    meta(payer.publicKey, true, true), meta(mint), meta(config), meta(vault, true), meta(SystemProgram.programId),
  ], le64(topUp))], signers(), 'Fund rent vault');
}
const [readyConfig, readyEaml, readyVault] = await Promise.all([
  connection.getAccountInfo(config, 'confirmed'),
  connection.getAccountInfo(eaml, 'confirmed'),
  connection.getAccountInfo(vault, 'confirmed'),
]);
if (!readyConfig?.owner.equals(PROGRAM_ID) || !readyEaml?.owner.equals(PROGRAM_ID) ||
    BigInt(readyVault?.lamports ?? 0) < vaultTarget) {
  throw new Error('Config, EAML, or vault was not confirmed; refusing pointer update');
}
if (!hook.programId?.equals(PROGRAM_ID)) {
  await simulateThenSend([
    createUpdateTransferHookInstruction(mint, admin.publicKey, PROGRAM_ID, [], TOKEN_2022_PROGRAM_ID),
  ], signers(), 'Update mint TransferHook program ID');
}
const updatedMint = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
requireEqual(getTransferHook(updatedMint).programId, PROGRAM_ID, 'Updated hook program ID');
const checkedTransfer = await createTransferCheckedWithTransferHookInstruction(
  connection, smokeSource, mint, smokeDestination, smokeOwner,
  smokeAmount, updatedMint.decimals, [], 'confirmed', TOKEN_2022_PROGRAM_ID,
);
const smokeSignature = await simulateThenSend([checkedTransfer], signers(ownerSigner), 'Checked transfer with THOOOK EAML');
console.log(`MAINNET HOOK SMOKE VERIFIED: ${smokeSignature}`);

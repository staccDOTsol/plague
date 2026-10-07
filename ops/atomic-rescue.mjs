// Rescue 5oCp / DZVf from their closed old hook programs. `setup` creates
// THOOOK state without touching the mint pointer. `rescue` atomically changes
// the pointer, buys a tiny amount through direct Orca SwapV2, and performs a
// checked transfer. A failed buy or hook CPI rolls back the pointer change.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Wallet } from '@coral-xyz/anchor';
import { Percentage } from '@orca-so/common-sdk';
import {
  PDAUtil, WhirlpoolContext, WhirlpoolIx, buildWhirlpoolClient,
  swapQuoteByInputToken,
} from '@orca-so/whirlpools-sdk';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createTransferCheckedInstruction,
  createUpdateTransferHookInstruction, getAccount,
  getAssociatedTokenAddressSync, getMint, getTransferHook,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';

const OWNER = new PublicKey('331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth');
const RECIPIENT = new PublicKey('99VXriv7RXJSypeJDBQtGRsak1n5o2NBzbtMXhHW2RNG');
const PRIZE_WALLET = new PublicKey('89VB5UmvopuCFmp5Mf8YPX28fGvvqn79afCgouQuPyhY');
const HOOK = new PublicKey('VwcGiFProGtfYLKsDpJuxZoYMFZpuZ1XT6MGmBd9AwU');
const WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const GGO8 = new PublicKey('GGo8ee2DkuX2oFminYuBphMwEiQ5BdCzyYd84Nnm24R5');
const MINTS = {
  dzvf: {
    mint: new PublicKey('DZVfZHdtS266p4qpTR7vFXxXbrBku18nt9Uxp4KD9bsi'),
    oldHook: new PublicKey('AxaViNQ6EwvHuhAXXgsHkjAVXJdRTemYJeJEepaT8zDX'),
    input: USDC, inputProgram: TOKEN_PROGRAM_ID, inputRaw: 100_000n,
    pool: new PublicKey('BD1NZPQ7ezLK3FKnxcaPDkrqsy3CSQbQs4SA8ogAnrWb'),
    poolOwners: [
      'BD1NZPQ7ezLK3FKnxcaPDkrqsy3CSQbQs4SA8ogAnrWb',
      '7Rhf2umm5X6utf1GQxEJTN78MF6iQmaPbZTvoGQmZtiV',
      '5x5jphJYMRXueZs7tsiF99JpzBtrJwDNqtU1unkQNs1T',
      'ENVxdxXtxsSDgiXAXTEWwMBGTsyjws7FNNk9Nqkoe1Fq',
    ].map((s) => new PublicKey(s)),
    decimals: 9, minInfectRaw: 100_000_000n, vaxBurnRaw: 1_000_000_000n,
    smokeRaw: 100_000_000n,
  },
  five: {
    mint: new PublicKey('5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd'),
    oldHook: new PublicKey('Dercf2y55NPs7MeGgb4xi2NKfHwEm5X7K2xR5dPBGtCV'),
    input: GGO8, inputProgram: TOKEN_2022_PROGRAM_ID, inputRaw: 1_000_000n,
    pool: new PublicKey('91KiSxVa1mipLotY8HcAwNPULPaSpwXZVM8xyS32t885'),
    poolOwners: [new PublicKey('91KiSxVa1mipLotY8HcAwNPULPaSpwXZVM8xyS32t885')],
    decimals: 6, minInfectRaw: 100_000n, vaxBurnRaw: 1_000_000n,
    smokeRaw: 100_000n,
  },
};
const VAULT_TARGET = 3_000_000n; // More than two 133-byte infection-status rents.
const SEND = process.argv.includes('--execute');
const name = process.argv.find((a) => a.startsWith('--mint='))?.slice(7);
const stage = process.argv.find((a) => a.startsWith('--stage='))?.slice(8) ?? 'plan';
if (!MINTS[name] || !['plan', 'setup', 'rescue'].includes(stage)) {
  throw new Error('Use --mint=dzvf|five --stage=plan|setup|rescue [--execute]');
}
const target = MINTS[name];
const expand = (p) => p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(p);
const keyOf = (seed, ...keys) => PublicKey.findProgramAddressSync([
  Buffer.from(seed), ...keys.map((k) => k.toBuffer()),
], HOOK)[0];
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const ownAta = (mint, program) => getAssociatedTokenAddressSync(mint, OWNER, false, program);
const ixList = (bundle) => [...bundle.instructions, ...bundle.cleanupInstructions];
const CONFIG = keyOf('config', target.mint);
const EAML = keyOf('extra-account-metas', target.mint);
const VAULT = keyOf('rent-vault', target.mint);
const ownerSource = ownAta(target.mint, TOKEN_2022_PROGRAM_ID);
const recipientDestination = getAssociatedTokenAddressSync(target.mint, RECIPIENT, false, TOKEN_2022_PROGRAM_ID);

function hookMetas(sourceOwner, destinationOwner) {
  return [
    meta(CONFIG),
    meta(keyOf('status', target.mint, sourceOwner)),
    meta(keyOf('status', target.mint, destinationOwner), true),
    meta(VAULT, true),
    meta(SystemProgram.programId),
    meta(HOOK),
    meta(EAML),
  ];
}

const handoff = await readFile(expand(process.env.HANDOFF_PATH ||
  '~/.codex/attachments/30108abc-191c-4b06-94e6-1811295a9e09/Pasted text.txt'), 'utf8');
const rpc = process.env.RPC_URL || handoff.match(/https:\/\/mainnet\.helius-rpc\.com\/\?api-key=[a-zA-Z0-9-]+/)?.[0];
if (!rpc) throw new Error('Missing mainnet RPC');
const connection = new Connection(rpc, 'confirmed');
if (!(await connection.getGenesisHash()).startsWith('5eykt4')) throw new Error('Refusing non-mainnet RPC');
const ownerKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(expand('~/hooked.json'), 'utf8'))));
if (!ownerKey.publicKey.equals(OWNER)) throw new Error('331n key mismatch');
const [mintInfo, hookInfo, configInfo, eamlInfo, vaultInfo, sourceInfo, destInfo] = await Promise.all([
  getMint(connection, target.mint, 'confirmed', TOKEN_2022_PROGRAM_ID),
  connection.getAccountInfo(HOOK, 'confirmed'),
  connection.getAccountInfo(CONFIG, 'confirmed'),
  connection.getAccountInfo(EAML, 'confirmed'),
  connection.getAccountInfo(VAULT, 'confirmed'),
  getAccount(connection, ownerSource, 'confirmed', TOKEN_2022_PROGRAM_ID),
  getAccount(connection, recipientDestination, 'confirmed', TOKEN_2022_PROGRAM_ID),
]);
if (!hookInfo?.executable || mintInfo.decimals !== target.decimals ||
    !getTransferHook(mintInfo)?.authority?.equals(OWNER)) throw new Error('Program, decimals, or authority mismatch');
if (sourceInfo.owner.toBase58() !== OWNER.toBase58() || !sourceInfo.mint.equals(target.mint) ||
    !destInfo.owner.equals(RECIPIENT) || !destInfo.mint.equals(target.mint)) {
  throw new Error('Smoke token account mismatch');
}
if (configInfo && (!configInfo.owner.equals(HOOK) || configInfo.data.length !== 673 ||
    configInfo.data.subarray(0, 8).toString() !== 'THOOKCFG' ||
    !configInfo.data.subarray(8, 40).equals(target.mint.toBuffer()) ||
    !configInfo.data.subarray(40, 72).equals(OWNER.toBuffer()))) throw new Error('Unexpected existing THOOOK config');
if (eamlInfo && !eamlInfo.owner.equals(HOOK)) throw new Error('Unexpected EAML owner');
if (vaultInfo && !vaultInfo.owner.equals(SystemProgram.programId)) throw new Error('Unexpected vault owner');
const currentPointer = getTransferHook(mintInfo).programId;
console.log(JSON.stringify({ mint: target.mint.toBase58(), stage, send: SEND,
  pointer: currentPointer?.toBase58(), config: CONFIG.toBase58(), eaml: EAML.toBase58(),
  vault: VAULT.toBase58(), vaultLamports: vaultInfo?.lamports ?? 0,
  ownerTokenRaw: sourceInfo.amount.toString(), recipientTokenRaw: destInfo.amount.toString(),
  confirmedSlot: await connection.getSlot('confirmed') }));

async function transmit(label, instructions, extraCheck = null) {
  const latest = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({ payerKey: OWNER, recentBlockhash: latest.blockhash,
    instructions }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const size = tx.serialize().length;
  if (size > 1232) throw new Error(`${label}: ${size} bytes exceeds Solana packet size`);
  tx.sign([ownerKey]);
  const sim = await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
  if (sim.value.err) {
    console.error(sim.value.logs?.slice(-55).join('\n'));
    throw new Error(`${label}: simulation failed ${JSON.stringify(sim.value.err)}`);
  }
  if (extraCheck) extraCheck(sim);
  console.log(`${label}: signed mainnet simulation PASSED, ${size} bytes, ${sim.value.unitsConsumed} CUs`);
  if (!SEND) return;
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
  const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  if (result.value.err) throw new Error(`${label}: confirmed failure ${JSON.stringify(result.value.err)}; ${signature}`);
  console.log(`${label}: confirmed ${signature}`);
}

if (stage === 'plan') process.exit(0);
if (stage === 'setup') {
  if (!currentPointer.equals(target.oldHook)) throw new Error('Unexpected current pointer');
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })];
  if (!configInfo) {
    const args = Buffer.concat([
      OWNER.toBuffer(), PRIZE_WALLET.toBuffer(),
      le64(target.minInfectRaw), le64(target.vaxBurnRaw), le64(target.minInfectRaw),
      Buffer.from([target.poolOwners.length]), ...target.poolOwners.map((x) => x.toBuffer()),
    ]);
    ixs.push({ programId: HOOK, keys: [meta(OWNER, true, true), meta(target.mint),
      meta(CONFIG, true), meta(SystemProgram.programId)], data: Buffer.concat([Buffer.from([0]), args]) });
  }
  if (!eamlInfo) ixs.push({ programId: HOOK,
    keys: [meta(OWNER, true, true), meta(target.mint), meta(CONFIG),
      meta(EAML, true), meta(SystemProgram.programId)], data: Buffer.from([1]) });
  if (BigInt(vaultInfo?.lamports ?? 0) < VAULT_TARGET) {
    const topUp = VAULT_TARGET - BigInt(vaultInfo?.lamports ?? 0);
    ixs.push({ programId: HOOK, keys: [meta(OWNER, true, true), meta(target.mint),
      meta(CONFIG), meta(VAULT, true), meta(SystemProgram.programId)],
    data: Buffer.concat([Buffer.from([2]), le64(topUp)]) });
  }
  if (ixs.length === 1) { console.log('Setup already complete'); process.exit(0); }
  await transmit('Stage THOOOK config/EAML/vault', ixs);
}
if (stage === 'rescue') {
  if (!currentPointer.equals(target.oldHook)) throw new Error('Pointer changed since plan');
  if (!configInfo?.owner.equals(HOOK) || !eamlInfo?.owner.equals(HOOK) ||
      BigInt(vaultInfo?.lamports ?? 0) < VAULT_TARGET) throw new Error('THOOOK setup not yet confirmed');
  const inputAta = ownAta(target.input, target.inputProgram);
  const inputInfo = await getAccount(connection, inputAta, 'confirmed', target.inputProgram);
  if (inputInfo.amount < target.inputRaw) throw new Error('Insufficient quote token');
  const ctx = WhirlpoolContext.from(connection, new Wallet(Keypair.generate()), undefined,
    undefined, {}, WHIRLPOOL_PROGRAM);
  const pool = await buildWhirlpoolClient(ctx).getPool(target.pool);
  const data = pool.getData();
  if (!data.tokenMintA.equals(target.mint) || !data.tokenMintB.equals(target.input)) {
    throw new Error('Unexpected pool mints');
  }
  const quote = await swapQuoteByInputToken(pool, target.input, new BN(target.inputRaw.toString()),
    Percentage.fromFraction(1, 100), WHIRLPOOL_PROGRAM, ctx.fetcher);
  if (quote.aToB || BigInt(quote.otherAmountThreshold.toString()) < target.smokeRaw * 2n) {
    throw new Error('Swap quote cannot fund smoke transfer');
  }
  const swapMetas = hookMetas(target.pool, OWNER);
  const swapIx = WhirlpoolIx.swapV2Ix(ctx.program, {
    ...quote, whirlpool: target.pool, tokenMintA: target.mint, tokenMintB: target.input,
    tokenOwnerAccountA: ownerSource, tokenOwnerAccountB: inputAta,
    tokenVaultA: data.tokenVaultA, tokenVaultB: data.tokenVaultB,
    tokenTransferHookAccountsA: swapMetas, tokenTransferHookAccountsB: [],
    tokenProgramA: TOKEN_2022_PROGRAM_ID, tokenProgramB: target.inputProgram,
    oracle: PDAUtil.getOracle(WHIRLPOOL_PROGRAM, target.pool).publicKey,
    tokenAuthority: OWNER,
  });
  const smokeIx = createTransferCheckedInstruction(ownerSource, target.mint,
    recipientDestination, OWNER, target.smokeRaw, target.decimals, [], TOKEN_2022_PROGRAM_ID);
  smokeIx.keys.push(...hookMetas(OWNER, RECIPIENT));
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
    createUpdateTransferHookInstruction(target.mint, OWNER, HOOK, [], TOKEN_2022_PROGRAM_ID),
    ...ixList(swapIx), smokeIx,
  ];
  console.log(JSON.stringify({ directPool: target.pool.toBase58(), inputRaw: target.inputRaw.toString(),
    quotedOutputRaw: quote.estimatedAmountOut.toString(), minOutputRaw: quote.otherAmountThreshold.toString(),
    smokeRaw: target.smokeRaw.toString(), newHookAccounts: swapMetas.length }));
  await transmit('Atomic pointer + direct buy + checked-transfer smoke', ixs, (sim) => {
    const logs = sim.value.logs || [];
    if (!logs.some((x) => x.includes('Program log: Instruction: SwapV2')) ||
        !logs.some((x) => x.includes(`Program ${HOOK.toBase58()} invoke`)) ||
        !logs.some((x) => x.includes(`Program ${HOOK.toBase58()} success`))) {
      throw new Error('Simulation omitted Whirlpool swap or successful THOOOK CPI');
    }
  });
  if (SEND) {
    const updated = await getMint(connection, target.mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    const sourceAfter = await getAccount(connection, ownerSource, 'confirmed', TOKEN_2022_PROGRAM_ID);
    const destAfter = await getAccount(connection, recipientDestination, 'confirmed', TOKEN_2022_PROGRAM_ID);
    if (!getTransferHook(updated)?.programId?.equals(HOOK) ||
        sourceAfter.amount <= sourceInfo.amount ||
        destAfter.amount < destInfo.amount + target.smokeRaw) {
      throw new Error('Post-confirmation pointer or token balance verification failed');
    }
    console.log('Confirmed THOOOK pointer, bought token balance, and smoke receipt');
  }
}

// Acquire tiny balances of the two rescued hook mints through direct Orca
// SwapV2, including the old hook's extra accounts. Every stage simulates first.
// No pointer is changed by this file. See program/scripts/mainnet-setup.mjs.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Wallet } from '@coral-xyz/anchor';
import { Percentage } from '@orca-so/common-sdk';
import {
  PDAUtil, TokenExtensionUtil, WhirlpoolContext, WhirlpoolIx,
  buildWhirlpoolClient, swapQuoteByInputToken,
} from '@orca-so/whirlpools-sdk';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction, getAccount, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';

const OWNER = new PublicKey('331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth');
const SMOKE_RECIPIENT = new PublicKey('99VXriv7RXJSypeJDBQtGRsak1n5o2NBzbtMXhHW2RNG');
const WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const DZVF = new PublicKey('DZVfZHdtS266p4qpTR7vFXxXbrBku18nt9Uxp4KD9bsi');
const GGO8 = new PublicKey('GGo8ee2DkuX2oFminYuBphMwEiQ5BdCzyYd84Nnm24R5');
const FIVE = new PublicKey('5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd');
const POOLS = {
  usdc: new PublicKey('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'),
  dzvf: new PublicKey('BD1NZPQ7ezLK3FKnxcaPDkrqsy3CSQbQs4SA8ogAnrWb'),
  ggo8: new PublicKey('7Rhf2umm5X6utf1GQxEJTN78MF6iQmaPbZTvoGQmZtiV'),
  five: new PublicKey('91KiSxVa1mipLotY8HcAwNPULPaSpwXZVM8xyS32t885'),
};
const PLAN = {
  usdc: { input: NATIVE_MINT, output: USDC, raw: 2_000_000n }, // 0.002 SOL
  dzvf: { input: USDC, output: DZVF, raw: 100_000n },    // 0.1 USDC
  ggo8: { input: DZVF, output: GGO8, raw: 1_000_000_000n }, // 1 DZVf
  five: { input: GGO8, output: FIVE, raw: 1_000_000n },  // 1 GGo8
};
const PROGRAMS = new Map([
  [NATIVE_MINT.toBase58(), TOKEN_PROGRAM_ID],
  [USDC.toBase58(), TOKEN_PROGRAM_ID],
  [DZVF.toBase58(), TOKEN_2022_PROGRAM_ID],
  [GGO8.toBase58(), TOKEN_2022_PROGRAM_ID],
  [FIVE.toBase58(), TOKEN_2022_PROGRAM_ID],
]);
const expand = (p) => p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(p);
const ata = (mint, owner = OWNER) => getAssociatedTokenAddressSync(mint, owner, false, PROGRAMS.get(mint.toBase58()));
const ixList = (bundle) => [...bundle.instructions, ...bundle.cleanupInstructions];

async function rpcUrl() {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  const handoff = await readFile(expand(process.env.HANDOFF_PATH ||
    '~/.codex/attachments/30108abc-191c-4b06-94e6-1811295a9e09/Pasted text.txt'), 'utf8');
  const url = handoff.match(/https:\/\/mainnet\.helius-rpc\.com\/\?api-key=[a-zA-Z0-9-]+/)?.[0];
  if (!url) throw new Error('Mainnet RPC not found');
  return url;
}

async function ownerSigner() {
  const bytes = JSON.parse(await readFile(expand(process.env.FEE_PAYER || '~/hooked.json'), 'utf8'));
  const key = Keypair.fromSecretKey(Uint8Array.from(bytes));
  if (!key.publicKey.equals(OWNER)) throw new Error('Fee payer identity mismatch');
  return key;
}

async function transmit(connection, label, instructions, execute) {
  const latest = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: OWNER, recentBlockhash: latest.blockhash, instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  if (tx.serialize().length > 1232) throw new Error(`${label}: ${tx.serialize().length} bytes exceeds Solana packet size`);
  // Sign before simulation so this uses the exact payer and signer set that
  // would be broadcast; key bytes are never logged.
  tx.sign([await ownerSigner()]);
  const sim = await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
  if (sim.value.err) {
    console.error(sim.value.logs?.slice(-35).join('\n'));
    throw new Error(`${label}: simulation failed ${JSON.stringify(sim.value.err)}`);
  }
  console.log(`${label}: simulation passed, ${tx.serialize().length} bytes, ${sim.value.unitsConsumed} CUs`);
  if (!execute) return;
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
  const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  if (result.value.err) throw new Error(`${label}: chain error ${JSON.stringify(result.value.err)}; ${signature}`);
  console.log(`${label}: confirmed ${signature}`);
}

async function prepare(connection, execute) {
  const all = [NATIVE_MINT, USDC, DZVF, GGO8, FIVE];
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 })];
  for (const mint of all) ixs.push(createAssociatedTokenAccountIdempotentInstruction(
    OWNER, ata(mint), OWNER, mint, PROGRAMS.get(mint.toBase58()), ASSOCIATED_TOKEN_PROGRAM_ID,
  ));
  for (const mint of [DZVF, FIVE]) ixs.push(createAssociatedTokenAccountIdempotentInstruction(
    OWNER, ata(mint, SMOKE_RECIPIENT), SMOKE_RECIPIENT, mint,
    PROGRAMS.get(mint.toBase58()), ASSOCIATED_TOKEN_PROGRAM_ID,
  ));
  const wsol = await getAccount(connection, ata(NATIVE_MINT), 'confirmed', TOKEN_PROGRAM_ID).catch(() => null);
  const deficit = 2_000_000n - (wsol?.amount ?? 0n);
  if (deficit > 0n) {
    ixs.push(SystemProgram.transfer({ fromPubkey: OWNER, toPubkey: ata(NATIVE_MINT), lamports: Number(deficit) }));
    ixs.push(createSyncNativeInstruction(ata(NATIVE_MINT)));
  }
  await transmit(connection, 'Create route ATAs + wrap ≤0.002 SOL', ixs, execute);
}

async function swap(connection, stage, execute) {
  const plan = PLAN[stage];
  const ctx = WhirlpoolContext.from(connection, new Wallet(Keypair.generate()), undefined,
    undefined, {}, WHIRLPOOL_PROGRAM);
  const pool = await buildWhirlpoolClient(ctx).getPool(POOLS[stage]);
  const data = pool.getData();
  const mints = [data.tokenMintA, data.tokenMintB];
  if (!mints.some((m) => m.equals(plan.input)) || !mints.some((m) => m.equals(plan.output))) {
    throw new Error(`${stage}: unexpected pool mints`);
  }
  const inputAccount = await getAccount(connection, ata(plan.input), 'confirmed',
    PROGRAMS.get(plan.input.toBase58()));
  const outputAccount = await getAccount(connection, ata(plan.output), 'confirmed',
    PROGRAMS.get(plan.output.toBase58()));
  if (inputAccount.amount < plan.raw) throw new Error(`${stage}: insufficient input balance: ${inputAccount.amount}`);
  const quote = await swapQuoteByInputToken(pool, plan.input, new BN(plan.raw.toString()),
    Percentage.fromFraction(1, 100), WHIRLPOOL_PROGRAM, ctx.fetcher);
  if (quote.estimatedAmountOut.isZero()) throw new Error(`${stage}: zero output quote`);
  const ownerA = ata(data.tokenMintA), ownerB = ata(data.tokenMintB);
  const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContext(ctx.fetcher, data);
  const hooks = await TokenExtensionUtil.getExtraAccountMetasForTransferHookForPool(
    connection, tokenExtensionCtx,
    quote.aToB ? ownerA : data.tokenVaultA,
    quote.aToB ? data.tokenVaultA : ownerA,
    quote.aToB ? OWNER : POOLS[stage],
    quote.aToB ? data.tokenVaultB : ownerB,
    quote.aToB ? ownerB : data.tokenVaultB,
    quote.aToB ? POOLS[stage] : OWNER,
  );
  if ((plan.input.equals(DZVF) || plan.output.equals(DZVF)) &&
      !hooks.tokenTransferHookAccountsA?.length) throw new Error(`${stage}: DZVf old hook EAML did not resolve`);
  if (stage === 'five' && !hooks.tokenTransferHookAccountsA?.length) {
    throw new Error('5oCp old hook EAML did not resolve');
  }
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }),
    ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
    ...ixList(WhirlpoolIx.swapV2Ix(ctx.program, {
      ...quote, whirlpool: POOLS[stage], tokenMintA: data.tokenMintA, tokenMintB: data.tokenMintB,
      tokenOwnerAccountA: ownerA, tokenOwnerAccountB: ownerB,
      tokenVaultA: data.tokenVaultA, tokenVaultB: data.tokenVaultB,
      tokenTransferHookAccountsA: hooks.tokenTransferHookAccountsA,
      tokenTransferHookAccountsB: hooks.tokenTransferHookAccountsB,
      tokenProgramA: PROGRAMS.get(data.tokenMintA.toBase58()),
      tokenProgramB: PROGRAMS.get(data.tokenMintB.toBase58()),
      oracle: PDAUtil.getOracle(WHIRLPOOL_PROGRAM, POOLS[stage]).publicKey,
      tokenAuthority: OWNER,
    }))];
  console.log(JSON.stringify({ stage, pool: POOLS[stage].toBase58(), input: plan.input.toBase58(),
    inputRaw: plan.raw.toString(), output: plan.output.toBase58(),
    quotedOutputRaw: quote.estimatedAmountOut.toString(), minimumOutputRaw: quote.otherAmountThreshold.toString(),
    hookAccountsA: hooks.tokenTransferHookAccountsA?.length ?? 0,
    hookAccountsB: hooks.tokenTransferHookAccountsB?.length ?? 0,
    outputBalanceBefore: outputAccount.amount.toString() }));
  await transmit(connection, `Direct Orca ${stage}`, ixs, execute);
  if (execute) {
    const after = await getAccount(connection, ata(plan.output), 'confirmed', PROGRAMS.get(plan.output.toBase58()));
    if (after.amount <= outputAccount.amount) throw new Error(`${stage}: no confirmed output token increase`);
    console.log(`${stage}: received ${after.amount - outputAccount.amount} raw units`);
  }
}

const stage = process.argv.find((a) => a.startsWith('--stage='))?.slice(8) ?? 'plan';
const execute = process.argv.includes('--execute');
if (!['plan', 'prepare', ...Object.keys(PLAN)].includes(stage)) throw new Error(`Unknown stage ${stage}`);
const connection = new Connection(await rpcUrl(), 'confirmed');
const genesis = await connection.getGenesisHash();
if (!genesis.startsWith('5eykt4')) throw new Error('Refusing non-mainnet RPC');
console.log(`Mainnet confirmed slot ${await connection.getSlot('confirmed')}; stage=${stage}; execute=${execute}`);
if (stage === 'plan') {
  console.log('Stages: prepare, usdc, dzvf, ggo8, five. Swap spend capped at 0.002 SOL + 0.1 USDC + 1 DZVf + 1 GGo8; ATAs and network fees extra.');
} else if (stage === 'prepare') await prepare(connection, execute);
else await swap(connection, stage, execute);

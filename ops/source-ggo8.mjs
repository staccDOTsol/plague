// One small, independently checked WSOL -> GGo8 Raydium CP route to seed the
// direct Orca 5oCp purchase. Jupiter constructs the single-pool transaction;
// this script verifies every outer instruction and simulates balance deltas.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  Connection, Keypair, PublicKey, SystemInstruction,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';

const OWNER = new PublicKey('331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth');
const GGO8 = new PublicKey('GGo8ee2DkuX2oFminYuBphMwEiQ5BdCzyYd84Nnm24R5');
const GGO8_ATA = getAssociatedTokenAddressSync(GGO8, OWNER, false, TOKEN_2022_PROGRAM_ID);
const WSOL_ATA = new PublicKey('DrfWXM7aEjsYNBCYHWRv57aor2etiuum97HedhcPmPdu');
const RAYDIUM_POOL = '2mEgtAUVfoNHbNNBph2WtAR54m7GoHe3sGwM4WYCYe5o';
const INPUT_LAMPORTS = 1_000_000n;
const EXECUTE = process.argv.includes('--execute');
const expand = (p) => p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(p);

const handoff = await readFile(expand(process.env.HANDOFF_PATH ||
  '~/.codex/attachments/30108abc-191c-4b06-94e6-1811295a9e09/Pasted text.txt'), 'utf8');
const rpc = process.env.RPC_URL || handoff.match(/https:\/\/mainnet\.helius-rpc\.com\/\?api-key=[a-zA-Z0-9-]+/)?.[0];
if (!rpc) throw new Error('Missing mainnet RPC');
const connection = new Connection(rpc, 'confirmed');
if (!(await connection.getGenesisHash()).startsWith('5eykt4')) throw new Error('Not mainnet');
const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(expand('~/hooked.json'), 'utf8'))));
if (!key.publicKey.equals(OWNER)) throw new Error('331n key mismatch');
const beforeSol = BigInt(await connection.getBalance(OWNER, 'confirmed'));
const beforeToken = (await getAccount(connection, GGO8_ATA, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount;

const endpoint = new URL('https://lite-api.jup.ag/swap/v1/quote');
for (const [name, value] of Object.entries({
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: GGO8.toBase58(), amount: INPUT_LAMPORTS.toString(),
  slippageBps: '100', onlyDirectRoutes: 'true', instructionVersion: 'V2',
})) endpoint.searchParams.set(name, value);
const quoteResponse = await (await fetch(endpoint)).json();
if (quoteResponse.inputMint !== 'So11111111111111111111111111111111111111112' ||
    quoteResponse.outputMint !== GGO8.toBase58() ||
    quoteResponse.inAmount !== INPUT_LAMPORTS.toString() ||
    quoteResponse.routePlan?.length !== 1 ||
    quoteResponse.routePlan[0]?.swapInfo?.label !== 'Raydium CP' ||
    quoteResponse.routePlan[0]?.swapInfo?.ammKey !== RAYDIUM_POOL ||
    BigInt(quoteResponse.otherAmountThreshold || 0) < 1_000_000n) {
  throw new Error(`Unexpected direct Raydium quote: ${JSON.stringify({ error: quoteResponse.error, route: quoteResponse.routePlan })}`);
}
const swapResponse = await (await fetch('https://lite-api.jup.ag/swap/v1/swap', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ quoteResponse, userPublicKey: OWNER.toBase58(),
    wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 0 }),
})).json();
if (!swapResponse.swapTransaction) throw new Error(`Swap build failed: ${swapResponse.error}`);
const tx = VersionedTransaction.deserialize(Buffer.from(swapResponse.swapTransaction, 'base64'));
const tables = await Promise.all(tx.message.addressTableLookups.map(async (lookup) =>
  (await connection.getAddressLookupTable(lookup.accountKey)).value));
if (tables.some((x) => !x)) throw new Error('Unresolved Jupiter address lookup table');
const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
if (!message.payerKey.equals(OWNER) || tx.message.header.numRequiredSignatures !== 1 ||
    message.instructions.length !== 5) throw new Error('Unexpected transaction shape');
const [budget, transfer, sync, swap, close] = message.instructions;
if (budget.programId.toBase58() !== 'ComputeBudget111111111111111111111111111111' ||
    !transfer.programId.equals(new PublicKey('11111111111111111111111111111111')) ||
    BigInt(SystemInstruction.decodeTransfer(transfer).lamports) !== INPUT_LAMPORTS ||
    !SystemInstruction.decodeTransfer(transfer).toPubkey.equals(WSOL_ATA) ||
    !SystemInstruction.decodeTransfer(transfer).fromPubkey.equals(OWNER) ||
    sync.programId.toBase58() !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ||
    sync.data[0] !== 17 || !sync.keys[0].pubkey.equals(WSOL_ATA) ||
    swap.programId.toBase58() !== 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' ||
    !swap.keys.some((k) => k.pubkey.toBase58() === RAYDIUM_POOL) ||
    !swap.keys.some((k) => k.pubkey.equals(GGO8_ATA)) ||
    close.programId.toBase58() !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ||
    close.data[0] !== 9 || !close.keys[0].pubkey.equals(WSOL_ATA) ||
    !close.keys[1].pubkey.equals(OWNER)) throw new Error('Unexpected swap instruction or wallet movement');

tx.sign([key]);
const sim = await connection.simulateTransaction(tx, {
  sigVerify: true, commitment: 'confirmed',
  accounts: { encoding: 'base64', addresses: [OWNER.toBase58(), GGO8_ATA.toBase58()] },
});
if (sim.value.err) {
  console.error(sim.value.logs?.slice(-35).join('\n'));
  throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
}
const [ownerAfter, tokenAfter] = sim.value.accounts || [];
if (!ownerAfter || !tokenAfter) throw new Error('Simulation omitted post accounts');
const simSol = BigInt(ownerAfter.lamports);
const simAmount = Buffer.from(tokenAfter.data[0], 'base64').readBigUInt64LE(64);
if (beforeSol - simSol > INPUT_LAMPORTS + 50_000n ||
    simAmount - beforeToken < BigInt(quoteResponse.otherAmountThreshold)) {
  throw new Error('Simulated wallet deltas exceeded cap or output minimum');
}
console.log(JSON.stringify({ route: RAYDIUM_POOL, inputLamports: INPUT_LAMPORTS.toString(),
  quotedGgo8Raw: quoteResponse.outAmount, minimumGgo8Raw: quoteResponse.otherAmountThreshold,
  simulatedSolDebit: (beforeSol - simSol).toString(),
  simulatedGgo8Gain: (simAmount - beforeToken).toString(), mode: EXECUTE ? 'broadcast' : 'simulation only' }));
if (EXECUTE) {
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
  const result = await connection.confirmTransaction({ signature,
    blockhash: tx.message.recentBlockhash, lastValidBlockHeight: swapResponse.lastValidBlockHeight }, 'confirmed');
  if (result.value.err) throw new Error(`Swap failed: ${JSON.stringify(result.value.err)}; ${signature}`);
  const confirmed = (await getAccount(connection, GGO8_ATA, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount;
  if (confirmed - beforeToken < BigInt(quoteResponse.otherAmountThreshold)) throw new Error('Confirmed output below quoted minimum');
  console.log(`GGo8 acquired: ${confirmed - beforeToken} raw units; signature ${signature}`);
}

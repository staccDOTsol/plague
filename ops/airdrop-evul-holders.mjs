// Snapshot holders of a mint (wallets only, pool/PDA owners excluded) above a
// threshold, then mint a fixed amount of XEEu to each. MintTo does not invoke
// the transfer hook, so fresh wallets receive and become eligible holders.
// --execute sends; otherwise this only simulates and writes the snapshot.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, unpackMint, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from '@solana/spl-token';
const SOURCE = new PublicKey(process.env.SOURCE_MINT || 'EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump');
const TARGET = new PublicKey('XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo');
const THRESHOLD_UI = BigInt(process.env.THRESHOLD || '100'), AMOUNT_UI = BigInt(process.env.AMOUNT || '100'), PER_TX = 5;
const config = await readFile(new URL('./secrets/mainnet-cli-config.yml', import.meta.url), 'utf8');
const rpc = process.env.RPC_URL || config.match(/json_rpc_url:\s*["']?([^\s"']+)/)?.[1];
const connection = new Connection(rpc, 'confirmed');
if (!(await connection.getGenesisHash()).startsWith('5eykt4')) throw new Error('Mainnet only');
const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(`${homedir()}/hooked.json`, 'utf8'))));
const [sourceInfo, targetInfo] = await connection.getMultipleAccountsInfo([SOURCE, TARGET]);
const source = unpackMint(SOURCE, sourceInfo, sourceInfo.owner), target = unpackMint(TARGET, targetInfo, targetInfo.owner);
assert(target.mintAuthority?.equals(signer.publicKey), 'signer is not the XEEu mint authority');
const slot = await connection.getSlot('confirmed');
const accounts = await connection.getProgramAccounts(sourceInfo.owner, { commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: SOURCE.toBase58() } }] });
const byOwner = new Map();
for (const { account } of accounts) {
  if (account.data.length < 165) continue;
  const owner = new PublicKey(account.data.subarray(32, 64)).toBase58();
  byOwner.set(owner, (byOwner.get(owner) || 0n) + account.data.readBigUInt64LE(64));
}
const threshold = THRESHOLD_UI * 10n ** BigInt(source.decimals);
const candidates = [...byOwner].filter(([, amount]) => amount > threshold).map(([owner, amount]) => ({ owner, amount }));
const ownerInfos = await connection.getMultipleAccountsInfo(candidates.map((c) => new PublicKey(c.owner)));
const eligible = [], excluded = [];
candidates.forEach((c, i) => {
  const key = new PublicKey(c.owner);
  const wallet = PublicKey.isOnCurve(key.toBytes()) && (!ownerInfos[i] || ownerInfos[i].owner.equals(new PublicKey('11111111111111111111111111111111')));
  (wallet ? eligible : excluded).push({ owner: c.owner, source: (Number(c.amount) / 10 ** source.decimals).toString(), reason: wallet ? undefined : 'program-owned or off-curve (pool/PDA)' });
});
eligible.sort((a, b) => Number(b.source) - Number(a.source));
console.log(JSON.stringify({ source: SOURCE.toBase58(), slot, tokenAccounts: accounts.length, owners: byOwner.size, aboveThreshold: candidates.length, eligibleWallets: eligible.length, excluded }));
const amount = AMOUNT_UI * 10n ** BigInt(target.decimals);
const batches = []; for (let i = 0; i < eligible.length; i += PER_TX) batches.push(eligible.slice(i, i + PER_TX));
const receipts = [];
for (const batch of batches) {
  const instructions = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 })];
  for (const { owner } of batch) {
    const wallet = new PublicKey(owner), ata = getAssociatedTokenAddressSync(TARGET, wallet, false, TOKEN_2022_PROGRAM_ID);
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, ata, wallet, TARGET, TOKEN_2022_PROGRAM_ID),
      createMintToInstruction(TARGET, ata, signer.publicKey, amount, [], TOKEN_2022_PROGRAM_ID));
  }
  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: latest.blockhash, instructions }).compileToV0Message());
  tx.sign([signer]);
  const simulation = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  assert.equal(simulation.value.err, null, simulation.value.logs?.join('\n'));
  const entry = { wallets: batch.map((b) => b.owner), simulated: true, units: simulation.value.unitsConsumed };
  if (process.argv.includes('--execute')) {
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
    assert.equal((await connection.confirmTransaction({ signature, ...latest }, 'confirmed')).value.err, null);
    entry.signature = signature; entry.solscan = `https://solscan.io/tx/${signature}`;
  }
  receipts.push(entry); console.log(JSON.stringify(entry));
}
await writeFile(new URL(`./secrets/airdrop-${SOURCE.toBase58().slice(0, 8)}-${slot}.json`, import.meta.url), JSON.stringify({ source: SOURCE.toBase58(), target: TARGET.toBase58(), slot, threshold: THRESHOLD_UI.toString(), amountEach: AMOUNT_UI.toString(), executed: process.argv.includes('--execute'), eligible, excluded, receipts }, null, 1));

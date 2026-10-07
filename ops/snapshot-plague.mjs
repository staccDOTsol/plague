import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

const OG_MINT = new PublicKey('CscZaq5twomhUkvCY8Jdd1tge32L4Yj9FbkFFEZQpump');
const RESCUED_MINT = new PublicKey('XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo');
const expand = (path) => path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);

async function rpcUrl() {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  const path = process.env.HANDOFF_PATH;
  if (!path) throw new Error('RPC_URL or HANDOFF_PATH is required');
  const handoff = await readFile(expand(path), 'utf8');
  const url = handoff.match(/https:\/\/mainnet\.helius-rpc\.com\/\?api-key=[^\s]+/)?.[0];
  if (!url) throw new Error('No Helius mainnet RPC URL found in handoff');
  return url;
}

async function main() {
  const endpoint = await rpcUrl();
  const connection = new Connection(endpoint, 'confirmed');
  // One getProgramAccounts response supplies every token-account balance at
  // one bank slot. Helius paginates over the entire Token Program and its DAS
  // holder index is not a fixed-slot snapshot, so use a single RPC bank read.
  const snapshotConnection = new Connection(
    process.env.SNAPSHOT_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
  if (!(await connection.getGenesisHash()).startsWith('5eykt4')) throw new Error('Expected mainnet');

  const [ogInfo, rescuedInfo] = await Promise.all([
    connection.getAccountInfo(OG_MINT, 'confirmed'),
    connection.getAccountInfo(RESCUED_MINT, 'confirmed'),
  ]);
  if (!ogInfo || !rescuedInfo) throw new Error('One of the supplied mint accounts does not exist');
  const tokenPrograms = [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()];
  if (!tokenPrograms.includes(ogInfo.owner.toBase58()) || !rescuedInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error('Unexpected token program ownership');
  }
  const [og, rescued] = await Promise.all([
    getMint(connection, OG_MINT, 'confirmed', ogInfo.owner),
    getMint(connection, RESCUED_MINT, 'confirmed', TOKEN_2022_PROGRAM_ID),
  ]);

  const snapshot = await snapshotConnection.getProgramAccounts(ogInfo.owner, {
    commitment: 'confirmed', withContext: true,
    dataSlice: { offset: 0, length: 72 },
    filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: OG_MINT.toBase58() } }],
  });
  const accounts = snapshot.value;
  const balances = new Map();
  let nonzeroAccounts = 0;
  let totalRaw = 0n;
  for (const { pubkey, account } of accounts) {
    const data = account.data;
    if (data.length < 72) continue;
    if (!data.subarray(0, 32).equals(OG_MINT.toBuffer())) continue;
    const amount = data.readBigUInt64LE(64);
    if (amount === 0n) continue;
    nonzeroAccounts++;
    totalRaw += amount;
    const owner = new PublicKey(data.subarray(32, 64)).toBase58();
    const row = balances.get(owner) || { owner, amountRaw: 0n, tokenAccounts: [] };
    row.amountRaw += amount;
    row.tokenAccounts.push(pubkey.toBase58());
    balances.set(owner, row);
  }
  const holders = [...balances.values()]
    .sort((a, b) => a.amountRaw === b.amountRaw ? a.owner.localeCompare(b.owner) : a.amountRaw > b.amountRaw ? -1 : 1)
    .map(({ owner, amountRaw, tokenAccounts }) => ({ owner, amountRaw: amountRaw.toString(), tokenAccounts }));

  const result = {
    cluster: 'mainnet-beta',
    slot: snapshot.context.slot,
    capturedAt: new Date().toISOString(),
    ogMint: OG_MINT.toBase58(),
    ogProgram: ogInfo.owner.toBase58(),
    ogDecimals: og.decimals,
    ogSupplyRawAtRead: og.supply.toString(),
    rescuedMint: RESCUED_MINT.toBase58(),
    rescuedDecimals: rescued.decimals,
    rescuedSupplyRawAtRead: rescued.supply.toString(),
    rescuedMintAuthority: rescued.mintAuthority?.toBase58() ?? null,
    holderCount: holders.length,
    nonzeroTokenAccountCount: nonzeroAccounts,
    holdersTotalRaw: totalRaw.toString(),
    holders,
  };
  const dir = resolve(process.cwd(), '..', 'snapshots');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `og-plague-${result.slot}.json`);
  await writeFile(path, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ path, slot: result.slot, holderCount: result.holderCount,
    nonzeroTokenAccountCount: result.nonzeroTokenAccountCount,
    holdersTotalRaw: result.holdersTotalRaw, ogDecimals: result.ogDecimals,
    rescuedDecimals: result.rescuedDecimals, rescuedMintAuthority: result.rescuedMintAuthority }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

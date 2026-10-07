// Read-only mainnet market discovery for the controlled hook mints.
import { readFile } from 'node:fs/promises';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { WhirlpoolContext } from '@orca-so/whirlpools-sdk';
import { TOKEN_2022_PROGRAM_ID, getTransferHook, unpackMint } from '@solana/spl-token';

const config = await readFile(new URL('./secrets/mainnet-cli-config.yml', import.meta.url), 'utf8');
const rpc = process.env.RPC_URL || config.match(/json_rpc_url:\s*["']?([^\s"']+)/)?.[1];
if (!rpc) throw new Error('Mainnet RPC is required');
const connection = new Connection(rpc, 'confirmed');
if (!(await connection.getGenesisHash()).startsWith('5eykt4')) throw new Error('Mainnet only');
const program = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const mints = [
  'XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo',
  '5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd',
  'DZVfZHdtS266p4qpTR7vFXxXbrBku18nt9Uxp4KD9bsi',
  'GGo8ee2DkuX2oFminYuBphMwEiQ5BdCzyYd84Nnm24R5',
];
const ctx = WhirlpoolContext.from(connection, new Wallet(Keypair.generate()), undefined, undefined, {}, program);
const discovered = await Promise.all(mints.flatMap((mint) => [101, 181].map((offset) =>
  connection.getProgramAccounts(program, { filters: [{ dataSize: 653 }, { memcmp: { offset, bytes: mint } }] }),
)));
const addresses = [...new Map(discovered.flat().map((account) => [account.pubkey.toBase58(), account.pubkey])).values()];
const pools = await Promise.all(addresses.map(async (address) => {
  const pool = await ctx.fetcher.getPool(address);
  return { pool: address.toBase58(), mintA: pool.tokenMintA.toBase58(), mintB: pool.tokenMintB.toBase58(),
    liquidity: pool.liquidity.toString(), tickSpacing: pool.tickSpacing, feeRate: pool.feeRate,
    vaultA: pool.tokenVaultA.toBase58(), vaultB: pool.tokenVaultB.toBase58() };
}));
const tokens = [...new Set(pools.flatMap((pool) => [pool.mintA, pool.mintB]))];
const infos = await connection.getMultipleAccountsInfo(tokens.map((mint) => new PublicKey(mint)), 'confirmed');
const tokenStates = tokens.map((mint, i) => {
  const info = infos[i];
  const decoded = unpackMint(new PublicKey(mint), info, info.owner);
  const hook = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? getTransferHook(decoded) : null;
  return { mint, decimals: decoded.decimals, tokenProgram: info.owner.toBase58(),
    hook: hook?.programId?.toBase58() || null, authority: hook?.authority?.toBase58() || null };
});
console.log(JSON.stringify({ slot: await connection.getSlot('confirmed'), tokens: tokenStates, pools }, null, 2));

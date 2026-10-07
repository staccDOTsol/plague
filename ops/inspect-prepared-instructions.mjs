import { readFile } from 'node:fs/promises';
import { Connection, PublicKey } from '@solana/web3.js';
import { executableRoutes } from '../backend/src/hooked-router.js';
import { MARKETS, CONTROLLER, WSOL } from '../backend/src/router-markets.js';
const config = await readFile(new URL('./secrets/mainnet-cli-config.yml', import.meta.url), 'utf8');
const rpc = process.env.RPC_URL || config.match(/json_rpc_url:\s*["']?([^\s"']+)/)?.[1];
const result = await executableRoutes(new Connection(rpc, 'confirmed'), WSOL, MARKETS[2].mint, '100000', new PublicKey(CONTROLLER));
const tx = result.prepared.tx;
for (const ix of tx.message.compiledInstructions) console.log(JSON.stringify({
  program: tx.message.staticAccountKeys[ix.programIdIndex].toBase58(), data: Buffer.from(ix.data).toString('hex'),
  accounts: ix.accountKeyIndexes.map((index, position) => ({ position, address: tx.message.staticAccountKeys[index].toBase58() })),
}));

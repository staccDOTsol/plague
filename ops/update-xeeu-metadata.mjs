// Update the self-hosted Token-2022 metadata after the public JSON and image
// are reachable. Simulates first; add --execute to broadcast on mainnet.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUpdateFieldInstruction } from '@solana/spl-token-metadata';
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const MINT = new PublicKey('XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo');
const AUTHORITY = new PublicKey('331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth');
const URI = 'https://api.captainhook.fun/token.json';
const NAME = 'Captain Hook';
const SYMBOL = 'HOOK';
const CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'secrets/mainnet-cli-config.yml');

async function rpcUrl() {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  const config = await readFile(CONFIG_PATH, 'utf8');
  const match = config.match(/^json_rpc_url:\s*(.+)$/m);
  if (!match) throw new Error('Set RPC_URL or provide the local mainnet CLI config.');
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

async function verifyHostedAssets() {
  const response = await fetch(URI, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Metadata URI returned HTTP ${response.status}`);
  const json = await response.json();
  if (json.name !== NAME || json.symbol !== SYMBOL || json.external_url !== 'https://captainhook.fun') {
    throw new Error('Hosted metadata identity differs from the planned on-chain fields.');
  }
  if (typeof json.image !== 'string' || !json.image.startsWith('https://api.captainhook.fun/')) {
    throw new Error('Hosted metadata image must be served by the live site.');
  }
  const image = await fetch(json.image, { method: 'HEAD', redirect: 'follow' });
  if (!image.ok || !image.headers.get('content-type')?.startsWith('image/')) {
    throw new Error(`Metadata image is unavailable: HTTP ${image.status}`);
  }
}

async function main() {
  await verifyHostedAssets();
  const connection = new Connection(await rpcUrl(), 'confirmed');
  const genesis = await connection.getGenesisHash();
  if (!genesis.startsWith('5eykt4')) throw new Error(`Expected Solana mainnet, got ${genesis}`);
  const old = await getTokenMetadata(connection, MINT, 'confirmed', TOKEN_2022_PROGRAM_ID);
  if (!old || !old.updateAuthority?.equals(AUTHORITY) || !old.mint.equals(MINT)) {
    throw new Error('The controlled mint metadata or update authority changed.');
  }
  const target = { name: NAME, symbol: SYMBOL, uri: URI };
  const instructions = Object.entries(target)
    .filter(([field, value]) => old[field] !== value)
    .map(([field, value]) => createUpdateFieldInstruction({
      programId: TOKEN_2022_PROGRAM_ID, metadata: MINT, updateAuthority: AUTHORITY,
      field, value,
    }));
  if (!instructions.length) {
    console.log('XEEu metadata is already current.');
    return;
  }
  const latest = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: AUTHORITY, recentBlockhash: latest.blockhash, instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  if (tx.serialize().length > 1232) throw new Error('Metadata transaction exceeds packet size.');
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' });
  if (sim.value.err) throw new Error(`Metadata simulation failed: ${JSON.stringify(sim.value.err)}\n${sim.value.logs?.slice(-12).join('\n')}`);
  console.log(JSON.stringify({ previous: { name: old.name, symbol: old.symbol, uri: old.uri }, target,
    simulatedUnits: sim.value.unitsConsumed, updateFields: instructions.length, execute: process.argv.includes('--execute') }, null, 2));
  if (!process.argv.includes('--execute')) return;
  const secretPath = process.env.FEE_PAYER || resolve(homedir(), 'hooked.json');
  const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(secretPath, 'utf8'))));
  if (!signer.publicKey.equals(AUTHORITY)) throw new Error('Fee payer is not 331n authority.');
  tx.sign([signer]);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  if (result.value.err) throw new Error(`Metadata transaction failed: ${JSON.stringify(result.value.err)}; ${signature}`);
  const now = await getTokenMetadata(connection, MINT, 'confirmed', TOKEN_2022_PROGRAM_ID);
  if (!Object.entries(target).every(([field, value]) => now[field] === value)) {
    throw new Error(`Metadata transaction confirmed but values differ; inspect ${signature}`);
  }
  console.log(`Confirmed https://solscan.io/tx/${signature}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

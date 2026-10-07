// Install runtime co-sign and receipt secrets without printing key material or
// adding it to the container image. Fly stages the values for the next deploy.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Keypair } from '@solana/web3.js';
import { CONTROLLER } from '../backend/src/router-markets.js';
const bytes = Uint8Array.from(JSON.parse(await readFile(`${homedir()}/hooked.json`, 'utf8')));
const signer = Keypair.fromSecretKey(bytes);
if (signer.publicKey.toBase58() !== CONTROLLER) throw new Error('Auction authority identity mismatch');
const child = spawn('flyctl', ['secrets', 'import', '--stage', '--app', 'thoook'], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(`AUCTION_AUTHORITY_SECRET=${Buffer.from(bytes).toString('base64')}\nTRADER_PREPARE_SECRET=${randomBytes(32).toString('hex')}\n`);
child.on('exit', (code) => { process.exitCode = code || 0; });

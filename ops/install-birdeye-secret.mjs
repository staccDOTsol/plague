// Stage the Birdeye API key (read from ~/birdeye.key) as a Fly secret for the
// Splash Pool pricing step, without printing it or baking it into the image.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
const key = (await readFile(`${homedir()}/birdeye.key`, 'utf8')).trim();
if (!/^[A-Za-z0-9]{16,}$/.test(key)) throw new Error('~/birdeye.key does not look like a Birdeye API key');
const child = spawn('flyctl', ['secrets', 'import', '--stage', '--app', 'thoook'], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(`BIRDEYE_API_KEY=${key}\n`);
child.on('exit', (code) => { process.exitCode = code || 0; });

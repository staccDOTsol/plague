import { readFile } from 'node:fs/promises';
import { Connection } from '@solana/web3.js';
const config = await readFile(new URL('./secrets/mainnet-cli-config.yml', import.meta.url), 'utf8');
const rpc = process.env.RPC_URL || config.match(/json_rpc_url:\s*["']?([^\s"']+)/)?.[1];
const connection = new Connection(rpc, 'confirmed');
for (const signature of [
  '4aBL77z9RcBgDqUTNUmfJ1yGQYYYg8S5fjPir4qemeh35qsK92rdvQvYgvs7eLjZZvYRQaYKvL3822pBBFpK8MAP',
  '4knMM7cdhSvuqXcKJTMxwFaBSermSQNLbZipprfw3pyPmT6vM8huUYmLMd9U3YYYJHy6xQuFBDzpcqAevpVB38Za',
]) {
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  const deltas = tx.meta.postBalances.map((value, i) => ({ address: keys.get(i).toBase58(),
    deltaLamports: value - tx.meta.preBalances[i] })).filter((entry) => entry.deltaLamports);
  console.log(JSON.stringify({ signature, fee: tx.meta.fee, deltas }));
}

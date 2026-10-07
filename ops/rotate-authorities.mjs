import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ID,
  createSetAuthorityInstruction,
  getMetadataPointerState,
  getMint,
  getTokenMetadata,
  getTransferHook,
} from '@solana/spl-token';
import { createUpdateAuthorityInstruction } from '@solana/spl-token-metadata';

// This is a rescue of roles that are currently held by the two local signers.
// The first column in the owner's inventory is the mint address. Other
// authorities on these mints belong to different keys and are not touched.
const listings = [
  { mint: '7C95pQAtX8M2U97Txut8JSKUp7VLJVyPVEL7xknUAWFy', signer: '99', roles: ['pointer', 'metadata'] },
  { mint: '5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd', signer: '99', roles: ['hook', 'pointer'] },
  { mint: 'DZVfZHdtS266p4qpTR7vFXxXbrBku18nt9Uxp4KD9bsi', signer: '99', roles: ['hook', 'pointer'] },
  { mint: 'DL8CcQBJT95hSyzJZE6x3PyafzjH2Xu8E1BdN7eWzwqF', signer: '89', roles: ['metadata'] },
  { mint: 'XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo', signer: '89', roles: ['mint', 'hook', 'pointer', 'metadata'] },
];

const sourceAddresses = {
  '99': '99VXriv7RXJSypeJDBQtGRsak1n5o2NBzbtMXhHW2RNG',
  '89': '89VB5UmvopuCFmp5Mf8YPX28fGvvqn79afCgouQuPyhY',
};
const destinationAddress = '331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth';

function expand(path) {
  return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);
}

async function readBase58Keypair(path, expected) {
  const secret = bs58.decode((await readFile(expand(path), 'utf8')).trim());
  const keypair = Keypair.fromSecretKey(secret);
  if (keypair.publicKey.toBase58() !== expected) throw new Error(`Signer identity mismatch: ${path}`);
  return keypair;
}

async function readJsonKeypair(path, expected) {
  const secret = JSON.parse(await readFile(expand(path), 'utf8'));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
  if (keypair.publicKey.toBase58() !== expected) throw new Error(`Signer identity mismatch: ${path}`);
  return keypair;
}

function address(value) {
  return value?.toBase58() ?? null;
}

function currentAuthority(state, role) {
  switch (role) {
    case 'mint': return address(state.mint.mintAuthority);
    case 'hook': return address(state.hook?.authority);
    case 'pointer': return address(state.pointer?.authority);
    case 'metadata': return address(state.metadata?.updateAuthority);
    default: throw new Error(`Unknown role ${role}`);
  }
}

async function readState(connection, mintAddress) {
  const mint = new PublicKey(mintAddress);
  const raw = await connection.getAccountInfo(mint, 'confirmed');
  if (!raw || !raw.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`${mintAddress} is not a live Token-2022 mint`);
  }
  const parsed = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  return {
    mint: parsed,
    hook: getTransferHook(parsed),
    pointer: getMetadataPointerState(parsed),
    metadata: await getTokenMetadata(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID),
  };
}

function buildInstructions(entry, source, target, state) {
  const mint = new PublicKey(entry.mint);
  const ixs = [];
  for (const role of entry.roles) {
    if (currentAuthority(state, role) === target.toBase58()) continue;
    if (role === 'metadata') {
      ixs.push(createUpdateAuthorityInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint,
        oldAuthority: source,
        newAuthority: target,
      }));
    } else {
      const kind = {
        mint: AuthorityType.MintTokens,
        hook: AuthorityType.TransferHookProgramId,
        pointer: AuthorityType.MetadataPointer,
      }[role];
      ixs.push(createSetAuthorityInstruction(mint, source, kind, target, [], TOKEN_2022_PROGRAM_ID));
    }
  }
  return ixs;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const solanaConfig = await readFile(expand('~/.config/solana/cli/config.yml'), 'utf8').catch(() => '');
  const handoff = process.env.HANDOFF_PATH ? await readFile(expand(process.env.HANDOFF_PATH), 'utf8') : '';
  const rpcUrl = process.env.RPC_URL
    || solanaConfig.match(/json_rpc_url:\s*(\S+)/)?.[1]
    || handoff.match(/https:\/\/mainnet\.helius-rpc\.com\/\?api-key=[^\s]+/)?.[0];
  if (!rpcUrl) throw new Error('RPC_URL, Solana CLI RPC config, or HANDOFF_PATH is required');
  const connection = new Connection(rpcUrl, 'confirmed');
  const genesis = await connection.getGenesisHash();
  if (!genesis.startsWith('5eykt4')) throw new Error(`Expected Solana mainnet, got genesis ${genesis}`);

  const keys = {
    '99': await readBase58Keypair(process.env.SIGNER_99 || '~/99rng.bs58', sourceAddresses['99']),
    '89': await readBase58Keypair(process.env.SIGNER_89 || '~/89vb.bs58', sourceAddresses['89']),
  };
  const payer = await readJsonKeypair(process.env.FEE_PAYER || '~/hooked.json', destinationAddress);
  const target = (await readJsonKeypair(process.env.DESTINATION || '~/hooked.json', destinationAddress)).publicKey;
  const feeBalance = await connection.getBalance(payer.publicKey, 'confirmed');
  if (feeBalance < 10_000_000) throw new Error('Fee payer balance below 0.01 SOL');

  // Check every role before any transaction is broadcast. This prevents a
  // stale inventory from becoming a partial, unreviewed authority change.
  const states = new Map();
  for (const entry of listings) {
    const state = await readState(connection, entry.mint);
    states.set(entry.mint, state);
    const expected = sourceAddresses[entry.signer];
    for (const role of entry.roles) {
      const actual = currentAuthority(state, role);
      if (actual !== expected && actual !== destinationAddress) {
        throw new Error(`${entry.mint} ${role}: expected ${expected} or destination, saw ${actual}`);
      }
    }
    console.log(`${entry.mint}: ${entry.roles.map((role) => `${role}=${currentAuthority(state, role) === destinationAddress ? 'rescued' : 'pending'}`).join(' ')}`);
  }

  const instructions = [];
  const signerIds = new Set();
  for (const entry of listings) {
    const pending = buildInstructions(entry, keys[entry.signer].publicKey, target, states.get(entry.mint));
    if (pending.length) signerIds.add(entry.signer);
    instructions.push(...pending);
  }
  if (!instructions.length) {
    console.log('All 11 held authority roles are already at the destination.');
    return;
  }
  const latest = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: latest.blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer, ...[...signerIds].map((id) => keys[id])]);
  const simulation = await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
  if (simulation.value.err) {
    console.error(simulation.value.logs?.slice(-12).join('\n'));
    throw new Error(`Rescue failed simulation: ${JSON.stringify(simulation.value.err)}`);
  }
  console.log(`Combined rescue simulation passed: ${instructions.length} authority changes, ${tx.serialize().length} bytes`);
  if (!execute) {
    console.log('Dry run only. Pass --execute to broadcast the atomic rescue transaction.');
    return;
  }

  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  if (result.value.err) throw new Error(`Rescue transaction failed: ${JSON.stringify(result.value.err)}`);
  for (const entry of listings) {
    const verified = await readState(connection, entry.mint);
    for (const role of entry.roles) {
      if (currentAuthority(verified, role) !== destinationAddress) {
        throw new Error(`${entry.mint} ${role} not at destination after ${signature}`);
      }
    }
  }
  console.log(`All 11 held authority roles verified at ${destinationAddress}; signature ${signature}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

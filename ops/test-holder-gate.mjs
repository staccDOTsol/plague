// Run the actual SBF artifact in LiteSVM with public mainnet mint/config/EAML
// snapshots. All mutation below is confined to the local VM; no key is loaded.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createInitializeAccount3Instruction, createMintToCheckedInstruction,
  createTransferCheckedWithTransferHookInstruction, getAccountLenForMint,
  getAssociatedTokenAddressSync, getExtraAccountMetas, getExtensionData, ExtensionType, unpackMint,
} from '@solana/spl-token';

const HOOK = new PublicKey('VwcGiFProGtfYLKsDpJuxZoYMFZpuZ1XT6MGmBd9AwU');
const MINTS = [
  'XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo',
  '5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd',
  'DZVfZHdtS266p4qpTR7vFXxXbrBku18nt9Uxp4KD9bsi',
].map((mint) => new PublicKey(mint));
const configText = await readFile(new URL('./secrets/mainnet-cli-config.yml', import.meta.url), 'utf8');
const rpc = process.env.RPC_URL || configText.match(/json_rpc_url:\s*["']?([^\s"']+)/)?.[1];
const connection = new Connection(rpc, 'confirmed');
if (!(await connection.getGenesisHash()).startsWith('5eykt4')) throw new Error('Snapshots must come from mainnet');
const pda = (seed, mint, owner) => PublicKey.findProgramAddressSync(
  [Buffer.from(seed), mint.toBuffer(), ...(owner ? [owner.toBuffer()] : [])], HOOK,
)[0];
export const snapshots = await Promise.all(MINTS.map(async (mint) => {
  const config = pda('config', mint), eaml = pda('extra-account-metas', mint);
  const infos = await connection.getMultipleAccountsInfo([mint, config, eaml], 'confirmed');
  assert(infos.every(Boolean), 'Mainnet mint/config/EAML must exist');
  return { mint, config, eaml, infos };
}));

export function fixture(snapshot, legacy = false) {
  const svm = new LiteSVM().withTransactionHistory(0n);
  svm.addProgramFromFile(HOOK, fileURLToPath(new URL('../program/target/deploy/thoook.so', import.meta.url)));
  const payer = Keypair.generate();
  svm.airdrop(payer.publicKey, 2_000_000_000n);
  // RPC JSON rounds u64::MAX rentEpoch to 2^64 in JavaScript. These exempt
  // accounts do not use rentEpoch; normalize it before crossing the NAPI boundary.
  const mintInfo = { ...snapshot.infos[0], rentEpoch: 0, data: Buffer.from(snapshot.infos[0].data) };
  // A synthetic mint authority is used only to seed local test holdings.
  mintInfo.data.writeUInt32LE(1, 0);
  payer.publicKey.toBuffer().copy(mintInfo.data, 4);
  const decodedBefore = unpackMint(snapshot.mint, mintInfo, TOKEN_2022_PROGRAM_ID);
  payer.publicKey.toBuffer().copy(getExtensionData(ExtensionType.TransferHook, decodedBefore.tlvData), 0);
  const configInfo = { ...snapshot.infos[1], rentEpoch: 0, data: Buffer.from(snapshot.infos[1].data) };
  payer.publicKey.toBuffer().copy(configInfo.data, 40);
  svm.setAccount(snapshot.mint, mintInfo);
  svm.setAccount(snapshot.config, configInfo);
  const eamlInfo = { ...snapshot.infos[2], rentEpoch: 0, data: Buffer.from(snapshot.infos[2].data) };
  if (legacy) {
    const data = Buffer.alloc(16 + 5 * 35);
    Buffer.from([105, 37, 101, 197, 75, 251, 102, 26]).copy(data);
    data.writeUInt32LE(4 + 5 * 35, 8); data.writeUInt32LE(5, 12);
    for (let i = 0; i < 5; i++) snapshot.config.toBuffer().copy(data, 17 + i * 35);
    eamlInfo.data = data;
  }
  svm.setAccount(snapshot.eaml, eamlInfo);
  const decodedMint = unpackMint(snapshot.mint, mintInfo, TOKEN_2022_PROGRAM_ID);
  const accountInfo = (address) => {
    const info = svm.getAccount(address);
    return info ? { ...info, data: Buffer.from(info.data) } : null;
  };
  function send(instructions, extra = []) {
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: svm.latestBlockhash() });
    tx.add(...instructions); tx.sign(payer, ...extra);
    return svm.sendTransaction(tx);
  }
  function succeeds(result) {
    if (result instanceof FailedTransactionMetadata) throw new Error(result.toString());
    return result;
  }
  function account(owner, balance = 0n, custom = false) {
    const signer = custom ? Keypair.generate() : null;
    const address = custom ? signer.publicKey : getAssociatedTokenAddressSync(
      snapshot.mint, owner, false, TOKEN_2022_PROGRAM_ID,
    );
    const instructions = [];
    if (custom) {
      const space = getAccountLenForMint(decodedMint);
      instructions.push(SystemProgram.createAccount({ fromPubkey: payer.publicKey,
        newAccountPubkey: address, lamports: Number(svm.minimumBalanceForRentExemption(BigInt(space))),
        space, programId: TOKEN_2022_PROGRAM_ID }),
      createInitializeAccount3Instruction(address, snapshot.mint, owner, TOKEN_2022_PROGRAM_ID));
    } else {
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, address, owner, snapshot.mint, TOKEN_2022_PROGRAM_ID,
      ));
    }
    if (balance) instructions.push(createMintToCheckedInstruction(snapshot.mint, address,
      payer.publicKey, balance, decodedMint.decimals, [], TOKEN_2022_PROGRAM_ID));
    succeeds(send(instructions, signer ? [signer] : []));
    return address;
  }
  function migrate() {
    const result = succeeds(send([{ programId: HOOK, data: Buffer.from([5]), keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: snapshot.mint, isSigner: false, isWritable: false },
      { pubkey: snapshot.config, isSigner: false, isWritable: false },
      { pubkey: snapshot.eaml, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ] }]));
    assert.equal(getExtraAccountMetas(accountInfo(snapshot.eaml)).length, 3);
    return result;
  }
  const amount = (address) => Buffer.from(svm.getAccount(address).data).readBigUInt64LE(64);
  const transferIx = (source, destination, raw) => createTransferCheckedWithTransferHookInstruction(
    { getAccountInfo: async (address) => accountInfo(address) }, source, snapshot.mint,
    destination, payer.publicKey, raw, decodedMint.decimals, [], 'confirmed', TOKEN_2022_PROGRAM_ID,
  );
  return { ...snapshot, svm, payer, send, succeeds, account, migrate, amount, transferIx };
}

for (const snapshot of snapshots) {
  test(`${snapshot.mint.toBase58().slice(0, 4)}: zero-balance recipient reverts atomically, including a one-unit transfer`, async () => {
    const f = fixture(snapshot); f.migrate();
    const source = f.account(f.payer.publicKey, 1_000_000n);
    const recipient = Keypair.generate().publicKey;
    const destination = f.account(recipient);
    const before = f.amount(source);
    const result = f.send([await f.transferIx(source, destination, 1n)]);
    assert(result instanceof FailedTransactionMetadata, 'A first transfer must fail');
    assert(result.meta().logs().some((line) => line.includes('existing holders only')));
    assert(result.meta().logs().some((line) => line.includes('0xd')));
    assert.equal(f.amount(source), before, 'Source movement must roll back');
    assert.equal(f.amount(destination), 0n, 'The incoming transfer cannot bootstrap eligibility');
  });
  test(`${snapshot.mint.toBase58().slice(0, 4)}: existing holder transfers without creating infection state or using a rent vault`, async () => {
    const f = fixture(snapshot); f.migrate();
    const source = f.account(f.payer.publicKey, 1_000_000n);
    const recipient = Keypair.generate().publicKey;
    const destination = f.account(recipient, 1n);
    const before = f.amount(destination);
    const result = f.succeeds(f.send([await f.transferIx(source, destination, 100n)]));
    assert(f.amount(destination) >= before);
    assert.equal(f.svm.getAccount(pda('status', f.mint, recipient)), null);
    assert.equal(f.svm.getAccount(pda('rent-vault', f.mint)), null);
    assert(!result.logs().some((line) => line.includes('THOOOK_EVENT')));
  });
}

test('a holder can receive into a fresh non-ATA account using their existing canonical ATA as proof', async () => {
  const f = fixture(snapshots[0]); f.migrate();
  const source = f.account(f.payer.publicKey, 1000n);
  const owner = Keypair.generate().publicKey;
  f.account(owner, 1n);
  const destination = f.account(owner, 0n, true);
  f.succeeds(f.send([await f.transferIx(source, destination, 100n)]));
  assert.equal(f.amount(destination), 100n);
});

test('a wallet can move its own holding into a new token account', async () => {
  const f = fixture(snapshots[0]); f.migrate();
  const source = f.account(f.payer.publicKey, 1000n);
  const destination = f.account(f.payer.publicKey, 0n, true);
  f.succeeds(f.send([await f.transferIx(source, destination, 1000n)]));
  assert.equal(f.amount(destination), 1000n);
});

test('another wallet’s token account cannot be substituted as holder proof', async () => {
  const f = fixture(snapshots[0]); f.migrate();
  const source = f.account(f.payer.publicKey, 1000n);
  const owner = Keypair.generate().publicKey;
  const proof = f.account(owner, 1n);
  const destination = f.account(owner, 0n, true);
  const wrongProof = f.account(Keypair.generate().publicKey, 1n);
  const ix = await f.transferIx(source, destination, 100n);
  const entry = ix.keys.find((entry) => entry.pubkey.equals(proof));
  assert(entry); entry.pubkey = wrongProof;
  assert(f.send([ix]) instanceof FailedTransactionMetadata);
  assert.equal(f.amount(destination), 0n);
});

test('legacy EAML transfers enforce the gate during the upgrade migration', async () => {
  const f = fixture(snapshots[0], true);
  const source = f.account(f.payer.publicKey, 1000n);
  const destination = f.account(Keypair.generate().publicKey);
  const result = f.send([await f.transferIx(source, destination, 100n)]);
  assert(result instanceof FailedTransactionMetadata);
  assert(result.meta().logs().some((line) => line.includes('existing holders only')));
  assert.equal(f.amount(destination), 0n);
});

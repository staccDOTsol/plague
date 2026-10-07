/** Deploy THOOOK to devnet with disposable keys, then prove a real Token-2022 transfer and wrapped burn. */
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  ExtensionType, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getMintLen, getAssociatedTokenAddressSync,
  createInitializeTransferHookInstruction, createUpdateTransferHookInstruction,
  createInitializeMintInstruction, createAssociatedTokenAccountInstruction,
  createMintToInstruction, createTransferCheckedWithTransferHookInstruction,
} = require('@solana/spl-token');

const rpc = process.env.DEVNET_RPC_URL || 'https://api.devnet.solana.com';
const connection = new Connection(rpc, 'confirmed');
const here = fileURLToPath(new URL('..', import.meta.url));
const artifact = resolve(here, 'target/deploy/thoook.so');
const scratch = mkdtempSync(join(tmpdir(), 'thoook-devnet-'));
const payer = Keypair.generate();
const program = Keypair.generate();
const payerPath = join(scratch, 'payer.json');
const programPath = join(scratch, 'program.json');
writeFileSync(payerPath, JSON.stringify(Array.from(payer.secretKey)), { mode: 0o600 });
writeFileSync(programPath, JSON.stringify(Array.from(program.secretKey)), { mode: 0o600 });
const u64 = (n) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(n));
  return out;
};
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, program.publicKey)[0];
const send = (instructions, extraSigners = []) => sendAndConfirmTransaction(
  connection, new Transaction().add(...instructions), [payer, ...extraSigners],
  { commitment: 'confirmed', preflightCommitment: 'confirmed' },
);
const ix = (tag, keys, rest = Buffer.alloc(0)) => ({
  programId: program.publicKey,
  keys,
  data: Buffer.concat([Buffer.from([tag]), rest]),
});
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

try {
  console.log('Disposable devnet payer:', payer.publicKey.toBase58());
  console.log('Disposable devnet program:', program.publicKey.toBase58());
  console.log('Temporary key files:', scratch);
  console.log('Requesting airdrop...');
  const air = await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(air, 'confirmed');
  console.log('Airdrop confirmed:', air);
  console.log('Deploying SBF binary on devnet...');
  execFileSync('solana', [
    'program', 'deploy', '--url', rpc, '--keypair', payerPath,
    '--program-id', programPath, artifact,
  ], { stdio: 'inherit', timeout: 180000 });
  const deployed = await connection.getAccountInfo(program.publicKey, 'confirmed');
  if (!deployed?.executable) throw new Error('Deployed program is not executable');

  const mint = Keypair.generate();
  const recipient = Keypair.generate();
  const prizeWallet = Keypair.generate().publicKey;
  const decimals = 0;
  const mintLen = getMintLen([ExtensionType.TransferHook]);
  const mintRent = await connection.getMinimumBalanceForRentExemption(mintLen);
  console.log('Creating disposable Token-2022 mint:', mint.publicKey.toBase58());
  await send([
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
      lamports: mintRent, space: mintLen, programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferHookInstruction(
      mint.publicKey, payer.publicKey, SystemProgram.programId, TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(
      mint.publicKey, decimals, payer.publicKey, null, TOKEN_2022_PROGRAM_ID,
    ),
  ], [mint]);

  const config = pda(Buffer.from('config'), mint.publicKey.toBuffer());
  const eaml = pda(Buffer.from('extra-account-metas'), mint.publicKey.toBuffer());
  const vault = pda(Buffer.from('rent-vault'), mint.publicKey.toBuffer());
  const initData = Buffer.concat([
    payer.publicKey.toBuffer(), prizeWallet.toBuffer(),
    u64(5), u64(3), u64(1), Buffer.from([0]),
  ]);
  console.log('Initializing config, EAML, and rent vault...');
  await send([ix(0, [
    meta(payer.publicKey, true, true), meta(mint.publicKey),
    meta(config, true), meta(SystemProgram.programId),
  ], initData)]);
  await send([ix(1, [
    meta(payer.publicKey, true, true), meta(mint.publicKey),
    meta(config), meta(eaml, true), meta(SystemProgram.programId),
  ])]);
  await send([ix(2, [
    meta(payer.publicKey, true, true), meta(mint.publicKey),
    meta(config), meta(vault, true), meta(SystemProgram.programId),
  ], u64(0.05 * LAMPORTS_PER_SOL))]);
  const eamlInfo = await connection.getAccountInfo(eaml, 'confirmed');
  if (!eamlInfo || !eamlInfo.owner.equals(program.publicKey)) throw new Error('EAML was not created');

  const source = getAssociatedTokenAddressSync(
    mint.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const destination = getAssociatedTokenAddressSync(
    mint.publicKey, recipient.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  await send([
    createAssociatedTokenAccountInstruction(
      payer.publicKey, source, payer.publicKey, mint.publicKey,
      TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountInstruction(
      payer.publicKey, destination, recipient.publicKey, mint.publicKey,
      TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    createMintToInstruction(
      mint.publicKey, source, payer.publicKey, 10, [], TOKEN_2022_PROGRAM_ID,
    ),
    createUpdateTransferHookInstruction(
      mint.publicKey, payer.publicKey, program.publicKey, [], TOKEN_2022_PROGRAM_ID,
    ),
  ]);
  console.log('Hook pointer updated; executing real checked transfer...');
  const transfer = await createTransferCheckedWithTransferHookInstruction(
    connection, source, mint.publicKey, destination, payer.publicKey,
    5, decimals, [], 'confirmed', TOKEN_2022_PROGRAM_ID,
  );
  const transferSig = await send([transfer]);
  const status = pda(Buffer.from('status'), mint.publicKey.toBuffer(), recipient.publicKey.toBuffer());
  const statusInfo = await connection.getAccountInfo(status, 'confirmed');
  if (!statusInfo || !statusInfo.owner.equals(program.publicKey) || statusInfo.data.length !== 133 ||
      statusInfo.data.subarray(0, 8).toString() !== 'THOOKSTS' ||
      !statusInfo.data.subarray(72, 104).equals(payer.publicKey.toBuffer()) ||
      statusInfo.data.readUInt32LE(104) !== 1) {
    throw new Error('Transfer succeeded but recipient status was not recorded correctly');
  }
  console.log('Checked transfer and infection confirmed:', transferSig);

  const burnSig = await send([ix(4, [
    meta(destination, true), meta(mint.publicKey, true), meta(recipient.publicKey, false, true),
    meta(config), meta(status, true), meta(vault, true),
    meta(TOKEN_2022_PROGRAM_ID), meta(SystemProgram.programId),
  ], u64(3))], [recipient]);
  const vaccinated = await connection.getAccountInfo(status, 'confirmed');
  if (!vaccinated || vaccinated.data.readBigUInt64LE(124) !== 3n ||
      vaccinated.data.readBigInt64LE(116) <= 0n) {
    throw new Error('Wrapped burn did not record vaccination');
  }
  console.log('Wrapped burn and vaccination confirmed:', burnSig);
  console.log(JSON.stringify({
    rpc, programId: program.publicKey.toBase58(), mint: mint.publicKey.toBase58(),
    config: config.toBase58(), eaml: eaml.toBase58(), vault: vault.toBase58(),
    status: status.toBase58(), transferSig, burnSig,
  }, null, 2));
} catch (error) {
  console.error('Devnet smoke failed:', error?.stack || error);
  process.exitCode = 1;
}

// On-chain readout for the XEEu/WSOL Whirlpool and the launch LP position.
// Orca's public indexer does not list this custom-config pool, so read RPC directly.
import { Wallet } from '@coral-xyz/anchor';
import { PoolUtil, PriceMath, WhirlpoolContext } from '@orca-so/whirlpools-sdk';
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';

const PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const POOL = new PublicKey('9zST8JLNeJXH518mDmAQRiKfYtoG8AymytyoEK8pkdfa');
const POSITION = new PublicKey('scKXkPydjjT6zsMcrK6FkwxGq5L4ikFaMQKhmdD2Kqw');
const CONTROLLER = new PublicKey('331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const XEEU = new PublicKey('XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo');

export async function readPoolPosition(connection) {
  const context = WhirlpoolContext.from(
    connection, new Wallet(Keypair.generate()), undefined, undefined, {}, PROGRAM,
  );
  const [pool, position] = await Promise.all([
    context.fetcher.getPool(POOL, true),
    context.fetcher.getPosition(POSITION, true),
  ]);
  if (!pool || !position || !pool.tokenMintA.equals(WSOL) ||
      !pool.tokenMintB.equals(XEEU) || !position.whirlpool.equals(POOL)) {
    throw new Error('The on-chain Whirlpool or launch position is unavailable');
  }
  const positionTokenAccount = getAssociatedTokenAddressSync(
    position.positionMint, CONTROLLER, false, TOKEN_PROGRAM_ID,
  );
  const [vaultWsol, vaultXeeu, positionToken] = await Promise.all([
    connection.getTokenAccountBalance(pool.tokenVaultA, 'confirmed'),
    connection.getTokenAccountBalance(pool.tokenVaultB, 'confirmed'),
    getAccount(connection, positionTokenAccount, 'confirmed', TOKEN_PROGRAM_ID).catch(() => null),
  ]);
  const amounts = PoolUtil.getTokenAmountsFromLiquidity(
    position.liquidity,
    pool.sqrtPrice,
    PriceMath.tickIndexToSqrtPriceX64(position.tickLowerIndex),
    PriceMath.tickIndexToSqrtPriceX64(position.tickUpperIndex),
    false,
  );
  return {
    chain: 'mainnet-beta',
    checkedAt: new Date().toISOString(),
    pool: POOL.toBase58(),
    config: pool.whirlpoolsConfig.toBase58(),
    position: POSITION.toBase58(),
    positionMint: position.positionMint.toBase58(),
    controller: CONTROLLER.toBase58(),
    controllerHoldsPositionNft: Boolean(positionToken?.owner.equals(CONTROLLER) && positionToken.amount === 1n),
    tickCurrent: pool.tickCurrentIndex,
    tickLower: position.tickLowerIndex,
    tickUpper: position.tickUpperIndex,
    tickSpacing: pool.tickSpacing,
    feeBps: pool.feeRate / 100,
    priceXeeuPerSol: PriceMath.sqrtPriceX64ToPrice(pool.sqrtPrice, 9, 9).toFixed(3),
    poolLiquidityRaw: pool.liquidity.toString(),
    positionLiquidityRaw: position.liquidity.toString(),
    estimatedPositionWsolRaw: amounts.tokenA.toString(),
    estimatedPositionXeeuRaw: amounts.tokenB.toString(),
    vaultWsolRaw: vaultWsol.value.amount,
    vaultXeeuRaw: vaultXeeu.value.amount,
  };
}

export function mountPoolReadout(app, connection) {
  let cached = null;
  let pending = null;
  app.get('/api/pool-position', async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      if (!cached || Date.now() - cached.at > 12_000) {
        if (!pending) {
          pending = readPoolPosition(connection).then((data) => {
            cached = { at: Date.now(), data };
            return data;
          }).finally(() => { pending = null; });
        }
        await pending;
      }
      response.json(cached.data);
    } catch {
      console.error('[pool-readout] on-chain position check failed');
      response.status(503).json({ error: 'Pool position data could not be read from mainnet. Retry shortly.' });
    }
  });
}

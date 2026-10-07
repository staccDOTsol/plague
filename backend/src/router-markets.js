// Public, mainnet-only execution registry. Pool addresses are checked against
// their on-chain mints on every fresh quote/prepare.
export const WSOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const GGO8 = 'GGo8ee2DkuX2oFminYuBphMwEiQ5BdCzyYd84Nnm24R5';
export const HOOK = 'VwcGiFProGtfYLKsDpJuxZoYMFZpuZ1XT6MGmBd9AwU';
export const CONTROLLER = '331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth';
export const ORCA = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
export const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
export const CPMM_AUTHORITY = 'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL';
export const SOL_USDC_POOL = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
export const SOL_GGO8_POOL = '2mEgtAUVfoNHbNNBph2WtAR54m7GoHe3sGwM4WYCYe5o';

export const MARKETS = [
  { id: 'xeeu', mint: 'XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo',
    label: 'XEEu', name: 'Captain Hook', decimals: 9, counterMint: WSOL,
    pool: '9zST8JLNeJXH518mDmAQRiKfYtoG8AymytyoEK8pkdfa',
    usdcPool: 'FnfJEV3FgH3H2kxYkvhJLkywXF8dvXJZCYBp4LHGV4jr' },
  { id: 'five', mint: '5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd',
    label: '5oCp', name: '5oCp hooked mint', decimals: 6, counterMint: GGO8,
    pool: '91KiSxVa1mipLotY8HcAwNPULPaSpwXZVM8xyS32t885' },
  { id: 'dzvf', mint: 'DZVfZHdtS266p4qpTR7vFXxXbrBku18nt9Uxp4KD9bsi',
    label: 'DZVf', name: 'DZVf hooked mint', decimals: 9, counterMint: USDC,
    pool: 'BD1NZPQ7ezLK3FKnxcaPDkrqsy3CSQbQs4SA8ogAnrWb' },
];
export const MARKET_BY_MINT = new Map(MARKETS.map((market) => [market.mint, market]));
export const KNOWN_HOOKED = new Set(MARKET_BY_MINT.keys());

export function routeCandidates(inputMint, outputMint) {
  const market = MARKET_BY_MINT.get(inputMint) || MARKET_BY_MINT.get(outputMint);
  if (!market || (MARKET_BY_MINT.has(inputMint) && MARKET_BY_MINT.has(outputMint))) return [];
  const buying = outputMint === market.mint;
  const counter = buying ? inputMint : outputMint;
  const route = (kind, pools, mints) => ({ market, buying, kind,
    pools: buying ? pools : [...pools].reverse(), mints: buying ? mints : [...mints].reverse() });
  if (counter === WSOL) {
    if (market.id === 'xeeu') return [
      route('orca', [market.pool], [WSOL, market.mint]),
      route('orca-two-hop', [SOL_USDC_POOL, market.usdcPool], [WSOL, USDC, market.mint]),
    ];
    if (market.id === 'dzvf') return [route('orca-two-hop', [SOL_USDC_POOL, market.pool], [WSOL, USDC, market.mint])];
    return [route('raydium-orca', [SOL_GGO8_POOL, market.pool], [WSOL, GGO8, market.mint])];
  }
  if (counter === market.counterMint) return [route('orca', [market.pool], [counter, market.mint])];
  if (market.id === 'xeeu' && counter === USDC) return [route('orca', [market.usdcPool], [USDC, market.mint])];
  return [];
}

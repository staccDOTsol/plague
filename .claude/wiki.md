## Hook auction is an English auction with anti-snipe (program v2, HKAUCT02)
Tags 6 init/migrate, 7 bid (escrow + refund previous leader), 8 settle (admin only, after clock), 9 void (admin refund + reopen). First bid starts the 30-min clock; bids in the last 5 min extend by 5 min. Settlement is driven by the backend settler loop in `backend/src/auction-market.js`, not by the buyer.
**Why:** the user rejected the Dutch "first taker wins" design: bidders must outbid each other and late bids must extend the round. The seller must settle because the winner may never show up.

## Settle CPI must run before moving escrow lamports
In `program/src/auction.rs` the Token-2022 hook-pointer CPI runs before `release()`; the recipient can alias the signing admin, and lamport moves before a CPI trip the runtime's UnbalancedInstruction check at the CPI boundary.
**Why:** LiteSVM reproduced the failure when seller == recipient (the operator self-settlement case).

## Prepared-transaction receipts hash intent, not raw message bytes
`intentHash()` in `backend/src/prepared-transactions.js` skips Lighthouse (`L2TExMF…S95`) instructions and compares payer, blockhash, and each remaining instruction's program, resolved keys, signer flags, and data.
**Why:** Phantom appends Lighthouse guard instructions before signing, which changed the raw message and produced TRANSACTION_CHANGED on every Phantom submit.

## Orca configs: no new configs, badges live on operator configs
Orca's whirlpool program rejects `initialize_config` from any wallet (ConstraintRaw on funder). Wallet `12Nqk2jyA3XNe3rPxAaLFixytmohnMrBfCsdwrCfWNm2` is fee and token-badge authority on ~170 existing per-mint configs (XEEu HDE78…, 5oCp 8pSEv…, DZVf Cc7Kd…). `backend/src/liquidity.js` discovers configs by TokenBadge accounts for the mint plus configs the wallet controls; anyone can init a pool once badges exist.
**Why:** hooked Token-2022 mints need a token badge on the pool's config, and the live pools were created under custom configs before Orca restricted config creation.

## Holder gate blocks first deposit into a fresh pool vault for THOOOK mints
`require_existing_holder` has no pool-vault exemption, so a brand-new Whirlpool vault (balance 0) cannot receive the first deposit of a THOOOK-hooked mint. Existing pools work because their vaults already hold balance. The liquidity overview warns about this.
**Why:** surfaced while building the Splash Pool wizard; changing the gate was out of scope.

## Pons launchpad source and the SafeMoon creator fund live in ~/omni-launcher, not here
Pons V2 (Robinhood Chain, chain id 4663) is a third-party launchpad; its verified sources, live addresses (`pons-bytecode/manifest.json`) and a Foundry setup pinned to Pons's compiler settings are in `~/omni-launcher`. The creator-fee-wallet fund that recreates SafeMoon (burn half, lock half as V4 liquidity, bounty to the cranker) is `~/omni-launcher/contracts/src/moon/SafeMoonCreatorFund.sol`, with fork tests against the live factory. Morpho Blue's canonical address has no code on chain 4663.
**Why:** the user asked about Pons from this repo; the first search here found nothing because Pons is a separate codebase.

## Mainnet program upgrades go through the ops CLI config, not the default solana config
`solana program deploy program/target/deploy/thoook.so --program-id ops/secrets/thoook-program-keypair.json -C ops/secrets/mainnet-cli-config.yml` uses the Helius RPC and the 331n upgrade authority (`~/hooked.json`). The default `solana config` keypair is 12Nqk (the Orca badge wallet), which is not the upgrade authority. The CLI auto-extends ProgramData. The pre-upgrade holder-gate binary is saved at `ops/secrets/thoook-onchain-v1-slot454012192.so` for rollback.
**Why:** a bare `solana program deploy` picks up the 12Nqk keypair and the public RPC, and the English-auction build is 6.5 KB larger than the old ProgramData allocation, so the deploy also needs auto-extend rent from 331n.

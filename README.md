# Captain Hook

An on-chain Token-2022 holder gate, hook-aware buy/sell router, English hook auctions with anti-snipe extension, and a guided Orca Splash Pool flow at [captainhook.fun](https://captainhook.fun).

The [current release](docs/captainhook-release.md) documents the live holder-only policy, three native buy/sell markets, repeating auction terms, deployment hashes, and verified receipts. The transfer path checks pre-existing balances and owners and writes no infection state. The launch history below describes the earlier release; the current holder gate supersedes its earlier infection behavior.

## Live mainnet state

| Component | Address or link | Status |
| --- | --- | --- |
| Pinocchio TransferHook | [`VwcGiFProGtfYLKsDpJuxZoYMFZpuZ1XT6MGmBd9AwU`](https://solscan.io/account/VwcGiFProGtfYLKsDpJuxZoYMFZpuZ1XT6MGmBd9AwU) | Deployed and invoked by checked transfers and Whirlpool swaps |
| XEEu / THOOOK mint | [`XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo`](https://solscan.io/token/XEEu6i2pqjsZn63spYuyDCd5yizaE1pJ7iPbNPW1oMo) | Hook pointer active; `331n` retains hook and mint authority |
| XEEu/WSOL Whirlpool | [`9zST8JLNeJXH518mDmAQRiKfYtoG8AymytyoEK8pkdfa`](https://solscan.io/account/9zST8JLNeJXH518mDmAQRiKfYtoG8AymytyoEK8pkdfa) | Live, funded position and successful buys |
| `5oCp...` | [`5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd`](https://solscan.io/token/5oCpEpFo17kqmcs3454dYFsLGhSNdoPsmSaDRxh5YCzd) | Migrated to THOOOK; successful direct Orca buy and checked transfer |
| `DZVf...` | [`DZVfZHdtS266p4qpTR7vFXxXbrBku18nt9Uxp4KD9bsi`](https://solscan.io/token/DZVfZHdtS266p4qpTR7vFXxXbrBku18nt9Uxp4KD9bsi) | Migrated to THOOOK; successful direct Orca buy and checked transfer |
| Buyer and LP UI | [thoook.fly.dev](https://thoook.fly.dev) | Live direct wallet buys and [on-chain position view](https://thoook.fly.dev/#pool-position) |

The [mainnet launch evidence](docs/mainnet-launch-proof.md) contains the deployment, pool, LP, migration, trade, and failed aggregator transaction receipts. A [separate buyer](https://solscan.io/tx/5d8XPUcjAH3W1R367oWkmCU26kJ6qDbd8vkSCdiJPgyrgfV7CJSM77q8enW3XrgYkBwFPPULDZ7JzvzigYjdTm9y) used the site's unsigned transaction builder to buy XEEu while the hook remained active.

## How it works

1. `program/` implements the Token-2022 TransferHook in Pinocchio. Each rescued mint has its own config, `ExtraAccountMetaList`, rent vault, and wallet infection status PDAs. The mint's literal hook authority remains `331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth` where it is controlled.
2. `backend/src/hook-market-server.js` reads mint, authority, hook, EAML, TokenBadge, fee tier, and pool state from mainnet. `backend/src/pool-readout.js` reads the XEEu pool and LP directly from RPC because Orca's public API does not list this custom-config pool.
3. `backend/src/direct-buy.js` prepares an **unsigned** XEEu buy transaction. It assembles Orca `SwapV2` with the hook's required remaining accounts, simulates it, and returns it to the browser for wallet signing. The server has no buyer keypair. `frontend/index.html` is the direct buy and on-chain position UI.
4. `ops/` contains operator scripts and receipts for mainnet setup, migration, first trade, and verification. Secrets and private snapshots are ignored by Git.

The hook runs during actual Token-2022 token transfers. It can credit infection lineage and process its dedicated burn-and-vaccinate instruction. See [program documentation](program/README.md) for the exact rules and limits. The older `backend/src/server.js` and archive page retain the original off-chain outbreak map; they are not the authoritative infection state for the new hook.

## Run locally

Use Node 22 and a Solana mainnet RPC endpoint. Keep RPC credentials in local environment variables or a deployment secret.

```sh
cd backend
npm ci
RPC_URL='https://your-mainnet-rpc' npm start
```

Open `http://localhost:8080`. The server exposes:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Health and chain mode |
| `GET /api/hook-market/listings` | Live read-only mint and pool checks |
| `POST /api/hook-market/preflight` | Read-only hook-change eligibility |
| `POST /api/swap/prepare` | Simulated, unsigned XEEu direct-buy transaction |
| `GET /api/swap/status/:signature` | Confirm a wallet-sent buy |
| `GET /api/pool-position` | Live on-chain XEEu pool and LP view |

To build and test the program:

```sh
cd program
cargo test --lib
cargo build-sbf
```

The production app uses `fly.toml` and `backend/Dockerfile`. Set `RPC_URL` as a Fly secret before deploying; the Docker image contains the UI and API. No operator keypair belongs in this image.

## Current routing boundary

**Direct Orca `SwapV2` works on mainnet when the transaction includes the hook's extra accounts.** Orca's public pool API currently returns 404 for the custom-config pools, Jupiter returns `TOKEN_NOT_TRADABLE`, and Titan reports no acceptable route. OKX quotes the XEEu pool, but its generated routed transaction [failed on-chain with error 6050](https://solscan.io/tx/4nQJS9uqAiecKtq1vXsJSiyLRFR93pxz852DoDEtbewSZ3h5XnvGtfxL2iHyVvgHNA19pNBmNhaHA5yZzhghkawK) because the Orca CPI received no hook extra accounts. A [Fluxbeam transaction](https://solscan.io/tx/Z3ezWw6pJ5sTit5LRCuk2DVxyzS5Mz8bajnCS3YcmVvs9PF4xBtfbGV9JttqfBUJMRFjxSiqztaAMMpRWL7pq7T) failed for the same reason. A quote or chart alone does not prove a usable retail route.

The two remaining rescued mints cannot presently be migrated under the same authority path: `7C95...` has a hook authority held by a PDA of a closed old program, and `DL8C...` lacks a TransferHook extension.

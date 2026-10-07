# Captain Hook release — 6 October 2026

## Public services

- Trading and auctions: https://captainhook.fun
- Mainnet API: https://api.captainhook.fun
- Proof page: https://project.captainhook.fun
- Vercel DNS points the public names at Fly. Fly has issued TLS certificates. `www.captainhook.fun`, `hooksare.fun`, and the old `thoook.fly.dev` landing page redirect to the canonical trading domain.

## Holder gate

The Pinocchio program is `VwcGiFProGtfYLKsDpJuxZoYMFZpuZ1XT6MGmBd9AwU`. Its current deployed SBF SHA-256 is `fd8d4c6d19736b724bb807700ef44288b0b958b13a994a1a6efac085392f3ba3` (English auction build, upgraded in slot 454105327). The previous holder-gate build `36a8832b…c27` is kept locally as a rollback binary outside Git.

The receiving wallet must already hold a positive amount of the same mint before a transfer. Execute runs after Token-2022 updates balances, so the gate subtracts the incoming net amount before checking eligibility. A separate canonical ATA can prove the wallet already holds the mint when receiving into another account. Same-owner moves from an existing holding are permitted. It creates no infection state and uses no infection rent reserve.

Error 13 (`0xd`) is `EXISTING_HOLDER_REQUIRED`. It applies to ordinary wallet transfers, including one-unit transfers, and to market buys. An existing-holder transfer succeeds; a zero-balance recipient transaction reverts atomically. All three controlled mints retain literal hook authority `331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth`.

- [Holder-gated program + auction upgrade](https://solscan.io/tx/4knMM7cdhSvuqXcKJTMxwFaBSermSQNLbZipprfw3pyPmT6vM8huUYmLMd9U3YYYJHy6xQuFBDzpcqAevpVB38Za)
- [Three EAMLs migrated](https://solscan.io/tx/4xUCmiuzA4xgrfNi8pRPVYMaQ9p1dACBp1Etb7fgLF85ZhbmhhvYvRZauC5WbAXLE8fPh4STzgDD42r5YyBb3Gb6)

## Router

XEEu is the default. Both buy and sell are implemented for:

| Mint | SOL path |
| --- | --- |
| XEEu | Best simulated native Whirlpool or atomic USDC two-hop |
| 5oCp | Raydium CP SOL/GGo8 bridge + Orca V2 GGo8/5oCp |
| DZVf | Atomic Orca V2 SOL/USDC/DZVf two-hop |

Ordinary unhooked pairs use Jupiter Ultra. Hooked pairs are detected before the Ultra builder is called. Unsupported hooked pairs are rejected explicitly. A connected holder's complete packet is simulated before approval and again after signing. Missing wallet token accounts use a separately simulated setup transaction and a freshly simulated swap afterward.

The Raydium/Orca bridge uses capped input and deterministic intermediate amounts in one atomic packet. Unused input remains with the wallet. WSOL cleanup returns native SOL to that wallet. Input caps, recipient accounts, output minimums, hook accounts, and registered pool paths are checked by the client before signing. HMAC preparation receipts are shared across Fly machines; the backend relays only the exact buyer-signed prepared message.

## Recurring auctions

**Live since 6 October 2026, 23:45 EDT:** the auction is an English auction with anti-snipe extension. Bidders escrow SOL on-chain, every raise must beat the leader by 10% and refunds the previous leader in the same instruction, the first bid starts a 30-minute clock, and any bid in the last 5 minutes extends the round by 5 minutes. When the clock runs out, 331n's authority settles automatically (payment, hook pointer, checked-transfer proof through the winning hook); a hook that cannot pass the proof gets the leader refunded and a fresh round. Bids are self-signed; nothing is co-signed. Build hash `fd8d4c6d19736b724bb807700ef44288b0b958b13a994a1a6efac085392f3ba3`, 23 LiteSVM cases, on-chain bytes verified against the local artifact after the upgrade.

- [Program upgrade to the English auction build](https://solscan.io/tx/23crcgPhmKhQgMoKt8od4BaR49po9HJ9Fvp4TUqATvC2i4mQrMxsStzJZd6GySZdQRMy3v1T5aSyjuwByBe1GAyN), slot 454105327. ProgramData was auto-extended to 124,928 bytes.
- [Three auction accounts migrated in place](https://solscan.io/tx/YD4NrVyXsjTTSTYqRWMfkRjbDnU9GG4mydpanUSS5oTpi5dLUAZfZJghHH9Z8uy5fwt4tXMCq5s1sghe28tJxFd): XEEu `4ixChgbzY9Lg8MHkrwEAkj2i4xRu2GdriZAAQpr3bvRS`, 5oCp `AYtCMu8gawq5oRV1SWyi1VaG9gQveA1hf38fjacEMKd`, DZVf `6yPUJFRWubLzZjMVjyR21mxB5JBzLhqXZ21kyZ2vH5PG`. Each kept round 2 and now carries 0.01 SOL opening, 1000 bps raises, 1800 s clock, 300 s extension.

The receipts below record the earlier Dutch-auction release that ran before this upgrade.

Approved terms: opening 0.1 SOL, floor 0.01 SOL, linear 30-minute decay, payment to 331n. Each successful settlement increments the round and resets its start timestamp in the same transaction. The seller retains the literal hook authority and co-signs each unchanged buyer-signed packet. The settlement includes payment, hook update, optional controlled metadata, and a one-raw-unit transfer through the proposed new hook. A bad proof reverts the entire settlement.

- [Initialize all three auctions](https://solscan.io/tx/5vXyPyHLk7fWC3PVNeg8hoyYy9PRfcw9DwSBdyKNPsgahjbU8U6U872b2uNkNwXKyQbdg7fkixQLAC6YFDpbPb6j)
- [XEEu operator self-test → round 2](https://solscan.io/tx/5s4CK3kWdgzkpeWeVk9fBQSVScNDwvPSBmPLJzxmNhB8AaKDbehtA8Ce8wvu3U5mweB2t3kmXvUtBZqLTcRHLR5F)
- [5oCp operator self-test → round 2](https://solscan.io/tx/3PkAzDEZwDE1g8V2sMrWtzpypzk4V1DPGnvG35kbHNNK7y6WBrLN76JQH13NY1sX4aXm8TXAhb3tdRbCec9atVyc)
- [DZVf operator self-test → round 2](https://solscan.io/tx/hPfL4tJvc7B7q5iLVhFN1mkWKjs7CJTPgTRMHEiijTMm6wN4nyQeESjpeKGjQ4WLJmVhcN5Y9uEYMtgCQcbE3eN)

These were operator self-settlements: buyer and recipient were the same owned wallet, so auction payment was net zero. They verify real settlement, hook proof, retained authority, and immediate round reset; they are not external-customer purchases.

## Identity and funds

The XEEu mint is branded `Captain Hook` / `HOOK` with https://api.captainhook.fun/token.json and a verified 512×512 token image. [Metadata transaction](https://solscan.io/tx/2Rwx3joLxovB4meLeUeUMy5KmRoopW8knmWWHt5ZyBDr4a4TgjnNG7EyzRVPZ6pQ1B1LXZQjvkUKrJPJsd96xQ53).

An empty deployment buffer `6k4mED7ud5HTM3WNdZpyofR2PT3qCt7cJTXYmcuaB7Td`, owned by the upgradeable loader and controlled by 331n, was closed to reclaim 0.47945548 SOL to 331n. The active program and its ProgramData account were unaffected. A missing operator WSOL ATA was recreated for verification; no swap was sent by that setup.

## Checks

- 17 actual-SBF LiteSVM tests: holder rejection/acceptance, ownership proof, atomic rollback, auction price/floor, stale-round rejection, seller co-sign, and immediate repeated reset.
- Mainnet signed simulations: positive and zero-holder transfers for all three mints.
- Mainnet complete buy/sell packet simulations: all six SOL directions.
- Browser validator checks: all six real packets accepted; modified debit/minimum/recipient packets and changed auction asks rejected.
- Production HTTP: unsigned trade and unsigned controller self-bid rejected before co-signing.
- TypeScript, widget build, and Next production build.
- Actual browser: default XEEu, three selectable mints, buy/sell controls, auction navigation, shared wallet eligibility, and 1440/840/390-pixel layout checks.

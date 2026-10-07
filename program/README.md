# Captain Hook Pinocchio program

## Current mainnet behavior

The current transfer path is a **read-only existing-holder gate**, not an infection recorder. It validates real Token-2022 source/destination owners and balances. Because Token-2022 invokes Execute after moving tokens, eligibility subtracts the incoming net amount; the receiving transfer cannot establish its own eligibility. The recipient must already hold the same mint, proven by the destination's pre-transfer balance or a separate canonical ATA. A wallet can move an existing holding between its own accounts.

Zero-balance recipients revert with custom error **13 / `0xd`** and an explicit existing-holder log. This applies to first-time market buys and wallet transfers, including one-unit transfers. Execute creates no status account and spends no status rent. Legacy status/burn instructions remain for compatibility; their old infection semantics below do not describe the current transfer path.

Current EAML: Token-2022 Program, Associated Token Program, and recipient canonical ATA. Execute receives eight ordered accounts: source, mint, destination, transfer authority, EAML, Token-2022 Program, Associated Token Program, recipient ATA. Legacy ten-account lists are accepted during migration with the same strict balance gate.

Additional current instructions:

| Tag | Purpose | Data / ordered accounts |
| --- | --- | --- |
| `5` | Migrate the canonical EAML | admin writable signer, mint, existing config, EAML writable, System Program |
| `6` | Initialize or migrate the English auction | min bid u64, min raise bps u64, clock seconds u64, anti-snipe seconds u64, recipient Pubkey; admin writable signer, mint, config, auction PDA writable, System Program. A deployed `HKAUCT01` Dutch account is resized in place, keeping its round counter and last result. |
| `7` | Bid | expected round u64, bid lamports u64, proposed hook Pubkey; bidder writable signer, mint, config, auction writable, previous leader writable (the bidder itself when no bid exists), proposed executable program, its EAML, System Program, bidder's existing holding account |
| `8` | Settle a finished round | expected round u64; admin signer, mint writable, config, auction writable, payment recipient writable, winning hook program, its EAML, Token-2022 Program, System Program |
| `9` | Void a round (refund the leader, reopen) | expected round u64; admin signer, mint, config, auction writable, leader writable |

Auction PDA seeds: `['auction', mint]`, layout `HKAUCT02`, 312 bytes. The auction is an **English auction with anti-snipe extension**:

- A bid escrows its lamports in the auction PDA. It must be at least the minimum bid, or beat the leader by the minimum raise (`ceil(bid × bps / 10000)`, never less than one lamport). The previous leader is refunded in the same instruction; naming the wrong previous-leader account fails.
- The first bid of a round starts the clock (`ends = now + duration`). A bid landing inside the final `extension` seconds sets `ends = now + extension`, so a last-second bid always leaves time to respond. Bids after `ends` fail with custom error 104.
- Only the mint's literal hook authority (admin) can settle, and only once `now ≥ ends` with a bid present. Settlement pays the escrow to the recipient, changes the hook pointer to the leader's proposed program, records the winner, and opens the next round immediately. The API appends a one-raw-unit checked transfer through the winning hook; if that proof cannot pass, the admin may void the round (tag 9), which refunds the leader in full and opens a new round.
- Bidders must be existing holders, and the proposed hook must be executable with an `Execute`-discriminated ExtraAccountMetaList for the mint, checked at bid time and again at settlement.

Custom errors: 100 bad auction, 101 stale round, 102 bid too low, 103 bad hook, 104 round ended, 105 round still live, 106 no bid, 107 wrong leader account.

Deployed terms (see `ops/initialize-auctions.mjs`): 0.01 SOL minimum bid, 10% minimum raise, 30-minute clock from the first bid, 5-minute anti-snipe extension, payment to 331n.

The SBF SHA-256 of this build is `fd8d4c6d19736b724bb807700ef44288b0b958b13a994a1a6efac085392f3ba3`; it was deployed to mainnet in slot 454105327 ([upgrade](https://solscan.io/tx/23crcgPhmKhQgMoKt8od4BaR49po9HJ9Fvp4TUqATvC2i4mQrMxsStzJZd6GySZdQRMy3v1T5aSyjuwByBe1GAyN)) and the three auction accounts were [migrated in place](https://solscan.io/tx/YD4NrVyXsjTTSTYqRWMfkRjbDnU9GG4mydpanUSS5oTpi5dLUAZfZJghHH9Z8uy5fwt4tXMCq5s1sghe28tJxFd), replacing the Dutch build `36a883…c27`. `node ../ops/test-auction.mjs` executes the actual SBF artifact in LiteSVM and verifies 23 gate/auction cases, including escrow, refund on outbid, anti-snipe extension, settlement, void, and in-place migration.

## Earlier wire format and legacy behavior

This is a real Pinocchio Token-2022 TransferHook program. The deployed program address is chosen by the deployment keypair; the code derives all PDAs from the runtime program ID and does not hard-code an address.

Build and host tests:

```sh
cd /Users/stacc/plague/program
cargo test --lib
cargo build-sbf
```

The deployable artifact is `target/deploy/thoook.so`. A host unit test or successful SBF build does **not** verify a Token-2022 transfer. The XEEu mainnet deployment was separately checked with a real checked transfer and a Whirlpool V2 swap; see the receipts below. For any additional mint, simulate its exact config, EAML, pointer update, and checked transfer before changing its live pointer. Deployment and mint authority operations require the operator's own keypair and are intentionally outside this program package.

## Initialization order

1. Deploy the SBF artifact and record the resulting program ID.
2. With the mint's current TransferHook authority signing, call `initialize_config`. The signer must match the mint extension's current authority. The hook program ID may be set to THOOOK before or after this call, but configure the program before making transfers through it.
3. Call `initialize_extra_account_meta_list` using the same admin signer. This creates the canonical `["extra-account-metas", mint]` PDA.
4. Call `fund_rent_vault`. The system-owned `["rent-vault", mint]` PDA pays rent when the hook creates a newly infected wallet status. Keep it funded for every expected new wallet status; each status occupies 133 bytes. If the reserve is short, the hook allows the transfer and emits a skipped-infection event.
5. Configure the actual Whirlpool PDA that owns the token vault as a pool owner, using `set_pool_owners` signed by admin. If the pool is initialized later, set it immediately after `InitializePoolV2` and before its first trade. Pool allowlisting uses the **token account owner**, not the token vault address.
6. Set the mint's TransferHook program ID to the deployed THOOOK ID and make a checked Token-2022 transfer with the EAML resolved. Whirlpool V2 trades must pass their TransferHook remaining accounts. A compute-budget instruction may be needed when a trade creates a new wallet status.

The mint must be owned by `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`. The initial admin is the mint's actual TransferHook authority at `initialize_config` time. Admin can update the pool allowlist; it does not acquire mint authority through this program.

## Wire format

All integers are little endian. Public keys are 32 raw bytes. For the custom instructions, the first byte is a tag. The standard SPL Execute instruction is the TransferHook interface's eight-byte discriminator followed by a `u64` amount.

| Tag | Instruction data after tag | Ordered accounts |
| --- | --- | --- |
| `0` | `patient_zero: Pubkey`, `prize_wallet: Pubkey`, `min_infect: u64`, `vax_burn: u64`, `min_active_hold: u64`, `pool_count: u8`, `pool_owners: Pubkey[pool_count]` | admin writable signer, mint, config PDA writable, System Program |
| `1` | empty | admin writable signer, mint, config PDA, EAML PDA writable, System Program |
| `2` | `lamports: u64` | funder writable signer, mint, config PDA, rent vault PDA writable, System Program |
| `3` | `pool_count: u8`, `pool_owners: Pubkey[pool_count]` | admin signer, mint, config PDA writable |
| `4` | `amount: u64` | source token account writable, mint writable, token authority signer, config PDA, owner status PDA writable, rent vault PDA writable, Token-2022 Program, System Program |
| SPL Execute | `0x692565c54bfb661a`, `amount: u64` | source token account, mint, destination token account, transfer authority, EAML PDA, config PDA, source-owner status PDA, destination-owner status PDA writable, rent vault PDA writable, System Program |

PDA seeds are `config/mint`, `extra-account-metas/mint`, `rent-vault/mint`, and `status/mint/token-account-owner`. EAML resolves source and destination status PDAs using the owner bytes at offset 32 of the respective Token-2022 token account. The list also includes config, rent vault, and System Program.

## Infection and burn rules

A pool owner's outgoing transfer credits generation 2 to the recipient, with parent set to the pool owner. A patient-zero transfer credits generation 1. Other infected, unvaccinated owners infect recipients at the parent's generation plus one. First infection is permanent; a second infection does not replace the original parent. A transfer must deliver at least `min_infect` **net of Token-2022 transfer fees**. Self transfers and transfers into the patient-zero wallet, prize wallet, or allowlisted pool owners do not infect. The Execute handler requires the source token account's `transferring` flag, so arbitrary callers cannot forge infections.

Token-2022 does not invoke transfer hooks on burns. To record burns for vaccination, the wallet must call tag `4`, which CPIs to Token-2022 `BurnChecked` and atomically increments its on-chain cumulative burned amount. An infected non-patient-zero wallet vaccinates when its cumulative wrapped burns reach `vax_burn`. A direct Token-2022 burn succeeds but is not counted by THOOOK. Frontends must route PLAGUE vaccination burns through tag `4`.

Infection is best effort when the rent reserve is depleted. If a qualifying recipient has no status and the vault lacks the remaining rent needed to create one, Execute emits event type `4` and returns success so token trading continues. The skipped infection is not retroactively restored. An operator should monitor the vault and replenish it.

`min_active_hold` is stored in the on-chain config for score/indexer calculations. A TransferHook invocation cannot enumerate a wallet's every token account, all descendants, epoch standings, prize balances, or fee claims. Those leaderboard and payout rules remain outside this hook until separately implemented in an on-chain settlement program. The UI/indexer should derive infection and vaccination from program state and events, rather than computing them from transfer history independently.

Events are emitted with `sol_log_data(["THOOOK_EVENT_V1", payload])`. Payload first byte: `1` infected (mint, wallet, parent, generation u32, via u8, net amount u64, timestamp i64); `2` burned (mint, wallet, amount u64, cumulative u64, timestamp i64); `3` vaccinated (mint, wallet, cumulative u64, timestamp i64); `4` infection skipped for insufficient reserve (mint, wallet, rent needed u64, vault lamports u64). `via` is `1` for pool and `2` for another wallet/patient zero. State is authoritative if events are missed.

## Mainnet verification and remaining limits

The Pinocchio unit tests pass and the deployed XEEu binary matched the local SBF artifact by SHA-256. XEEu's [hook pointer update](https://solscan.io/tx/4AVeRWU5FWuu1WsfytsCiU8K4tLozGEHNf6b6mWDc3nK7wiQSLyaxAaURMS2UVbuUxsswFQcEnYiLHxsFbH7Tc6C), [real Token-2022 checked transfer](https://solscan.io/tx/5nS33GRgVegdXaGy1ivtBm4FXEpUzLioANA4VTz8MCGiSPgC8pDkTWARR6V8eBpye5ChbMvDUQBgLoRfYiUBMquS), [liquidity deposit](https://solscan.io/tx/2KaUYghTzjKyHueMLN3jRnhEXgeCUNjFk4jnpe4HVyKMZUN9q7proL8QEzCRL2aVYrRykbYWMcapnoJhud1EPN97), and [Whirlpool V2 trade](https://solscan.io/tx/4zuRnGDWJg7ccG7FHufRiKAXFZDWzc9G3pd5MNB6CnxTjcxfZp72X8GUBbMYWMUQJ69uvpxEks8yNGz23CSE3ifm) all confirmed on mainnet. The trade created the buyer's infection status with the pool as parent. A [separate buyer](https://solscan.io/tx/5d8XPUcjAH3W1R367oWkmCU26kJ6qDbd8vkSCdiJPgyrgfV7CJSM77q8enW3XrgYkBwFPPULDZ7JzvzigYjdTm9y) also completed a live hooked buy. The additional 5oCp and DZVf mints were then migrated in [atomic pointer-change, buy, and checked-transfer transactions](https://solscan.io/tx/Cu5vuVnMAGQmYvEF5pr6aCNEvzRsvRyvh4chmMdfy38oSaeF99A8h95dpVJKYguaawAXD2cPkVnJ5KbhUtM5dip) and [the corresponding DZVf transaction](https://solscan.io/tx/5Yk7CNtWZh8fL3wkRwa748yZZnHn396ygcVcVHK4pjLitdg2c1AA8Uz34W8ne8iba7g6V8uwx23uZJVRw3828HU). Each recorded two THOOOK invocations.

Wrapped-burn vaccination and prize settlement have **not** been verified by live transactions. The program has not received an independent security audit. Infection state is best effort when the rent vault is depleted, as described above. The mainnet proof covers XEEu, 5oCp, and DZVf; the two other rescued mints cannot follow the same migration path because one hook authority is outside our control and the other mint has no TransferHook extension. Orca's public API and aggregator discovery remain separate from the onchain Whirlpool trades.

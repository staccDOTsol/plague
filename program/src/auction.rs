//! Continuously repeating English auctions with escrowed bids and anti-snipe
//! extension. The literal mint authority settles each finished round; the
//! program never takes custody of that authority.
use super::*;

const MAGIC: &[u8; 8] = b"HKAUCT02";
const LEGACY_MAGIC: &[u8; 8] = b"HKAUCT01";
const SIZE: usize = 312;
const BPS: u128 = 10_000;
const BAD_AUCTION: ProgramError = ProgramError::Custom(100);
const STALE_ROUND: ProgramError = ProgramError::Custom(101);
const BID_TOO_LOW: ProgramError = ProgramError::Custom(102);
const BAD_HOOK: ProgramError = ProgramError::Custom(103);
const ROUND_ENDED: ProgramError = ProgramError::Custom(104);
const ROUND_LIVE: ProgramError = ProgramError::Custom(105);
const NO_BID: ProgramError = ProgramError::Custom(106);
const BAD_BIDDER: ProgramError = ProgramError::Custom(107);

struct Auction {
    mint: Pubkey,
    admin: Pubkey,
    recipient: Pubkey,
    min_bid: u64,
    increment_bps: u64,
    duration: u64,
    extension: u64,
    round: u64,
    started: i64,
    ends: i64,
    bidder: Pubkey,
    bid: u64,
    hook: Pubkey,
    winner: Pubkey,
    paid: u64,
    won_hook: Pubkey,
    won_at: i64,
}

fn valid_terms(state: &Auction) -> bool {
    state.min_bid > 0 && state.increment_bps > 0 && state.increment_bps <= BPS as u64 && state.duration > 0
        && state.extension > 0 && state.extension <= state.duration && state.round > 0 && state.recipient != [0; 32]
}

fn read(info: &AccountInfo, mint: &Pubkey, program_id: &Pubkey) -> Result<Auction, ProgramError> {
    pda(info, &[b"auction", mint], program_id)?;
    need(info.owner() == program_id && info.data_len() == SIZE, BAD_AUCTION)?;
    let data = info.try_borrow_data()?;
    need(&data[..8] == MAGIC, BAD_AUCTION)?;
    let state = Auction {
        mint: key(&data, 8)?, admin: key(&data, 40)?, recipient: key(&data, 72)?,
        min_bid: u64_at(&data, 104)?, increment_bps: u64_at(&data, 112)?, duration: u64_at(&data, 120)?, extension: u64_at(&data, 128)?,
        round: u64_at(&data, 136)?, started: i64_at(&data, 144)?, ends: i64_at(&data, 152)?,
        bidder: key(&data, 160)?, bid: u64_at(&data, 192)?, hook: key(&data, 200)?,
        winner: key(&data, 232)?, paid: u64_at(&data, 264)?, won_hook: key(&data, 272)?, won_at: i64_at(&data, 304)?,
    };
    need(state.mint == *mint && valid_terms(&state), BAD_AUCTION)?;
    Ok(state)
}

fn write(info: &AccountInfo, state: &Auction) -> ProgramResult {
    require_writable(info)?;
    let mut data = info.try_borrow_mut_data()?;
    need(data.len() == SIZE, BAD_AUCTION)?;
    data[..8].copy_from_slice(MAGIC);
    for (at, value) in [(8, &state.mint), (40, &state.admin), (72, &state.recipient), (160, &state.bidder),
        (200, &state.hook), (232, &state.winner), (272, &state.won_hook)] {
        data[at..at + 32].copy_from_slice(value);
    }
    for (at, value) in [(104, state.min_bid), (112, state.increment_bps), (120, state.duration), (128, state.extension),
        (136, state.round), (192, state.bid), (264, state.paid)] {
        data[at..at + 8].copy_from_slice(&value.to_le_bytes());
    }
    for (at, value) in [(144, state.started), (152, state.ends), (304, state.won_at)] {
        data[at..at + 8].copy_from_slice(&value.to_le_bytes());
    }
    Ok(())
}

/// Lowest acceptable bid given the current leader.
fn minimum_next(state: &Auction) -> Result<u64, ProgramError> {
    if state.bid == 0 { return Ok(state.min_bid); }
    let raise = (state.bid as u128 * state.increment_bps as u128).div_ceil(BPS);
    let next = (state.bid as u128).checked_add(raise.max(1)).ok_or(OVERFLOW)?;
    u64::try_from(next).map_err(|_| OVERFLOW)
}

/// Round clock after a bid at `now`: the first bid starts it, and a bid inside
/// the anti-snipe window pushes the end out so the leader can be outbid.
fn next_end(state: &Auction, now: i64) -> Result<i64, ProgramError> {
    if state.ends == 0 { return now.checked_add(state.duration as i64).ok_or(OVERFLOW); }
    let window_start = state.ends.checked_sub(state.extension as i64).ok_or(OVERFLOW)?;
    if now >= window_start { now.checked_add(state.extension as i64).ok_or(OVERFLOW) } else { Ok(state.ends) }
}

fn check_hook(mint: &Pubkey, hook: &AccountInfo, eaml: &AccountInfo, expected: &Pubkey) -> ProgramResult {
    need(hook.key() == expected && hook.executable(), BAD_HOOK)?;
    pda(eaml, &[b"extra-account-metas", mint], hook.key())?;
    need(eaml.owner() == hook.key() && eaml.data_len() >= 16, BAD_HOOK)?;
    let list = eaml.try_borrow_data()?;
    need(list[..8] == EXECUTE_DISCRIMINATOR, BAD_HOOK)
}

/// Move escrowed lamports out of the program-owned auction account.
fn release(auction: &AccountInfo, to: &AccountInfo, lamports: u64) -> ProgramResult {
    require_writable(to)?;
    let rent_floor = Rent::get()?.minimum_balance(SIZE);
    let remaining = auction.lamports().checked_sub(lamports).ok_or(BAD_AUCTION)?;
    need(remaining >= rent_floor, BAD_AUCTION)?;
    *auction.try_borrow_mut_lamports()? = remaining;
    let credited = to.lamports().checked_add(lamports).ok_or(OVERFLOW)?;
    *to.try_borrow_mut_lamports()? = credited;
    Ok(())
}

fn reopen(state: &mut Auction, now: i64) -> ProgramResult {
    state.round = state.round.checked_add(1).ok_or(OVERFLOW)?;
    state.started = now; state.ends = 0;
    state.bidder = [0; 32]; state.bid = 0; state.hook = [0; 32];
    Ok(())
}

pub(super) fn initialize(program_id: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    need(a.len() == 5 && data.len() == 65, ProgramError::InvalidInstructionData)?;
    let (admin, mint, config, auction, system) = (&a[0], &a[1], &a[2], &a[3], &a[4]);
    require_signer(admin)?; require_writable(admin)?; require_writable(auction)?; require_system(system)?;
    let cfg = read_config(config, mint.key(), program_id)?;
    need(cfg.admin == *admin.key(), UNAUTHORIZED)?;
    let now = Clock::get()?.unix_timestamp;
    let mut state = Auction {
        mint: *mint.key(), admin: *admin.key(), recipient: key(data, 33)?,
        min_bid: u64_at(data, 1)?, increment_bps: u64_at(data, 9)?, duration: u64_at(data, 17)?, extension: u64_at(data, 25)?,
        round: 1, started: now, ends: 0, bidder: [0; 32], bid: 0, hook: [0; 32],
        winner: [0; 32], paid: 0, won_hook: [0; 32], won_at: 0,
    };
    need(valid_terms(&state), BAD_AUCTION)?;
    let bump = pda(auction, &[b"auction", mint.key()], program_id)?;
    if auction.owner() == program_id {
        // Migrate a deployed Dutch-auction account in place: keep the round
        // counter and last result, resize, and switch to English terms.
        {
            let old = auction.try_borrow_data()?;
            need(old.len() == 224 && &old[..8] == LEGACY_MAGIC && key(&old, 8)? == *mint.key() && key(&old, 40)? == *admin.key(), BAD_AUCTION)?;
            state.round = u64_at(&old, 128)?.max(1);
            state.winner = key(&old, 144)?; state.won_hook = key(&old, 176)?;
            state.paid = u64_at(&old, 208)?; state.won_at = i64_at(&old, 216)?;
        }
        let required = Rent::get()?.minimum_balance(SIZE);
        let shortfall = required.saturating_sub(auction.lamports());
        if shortfall > 0 { Transfer { from: admin, to: auction, lamports: shortfall }.invoke()?; }
        auction.resize(SIZE)?;
        pinocchio::log::sol_log("CAPTAINHOOK.FUN: Dutch auction migrated to English bidding with anti-snipe extension.");
        return write(auction, &state);
    }
    let bump_bytes = [bump];
    let seeds = pinocchio::seeds!(b"auction", mint.key(), &bump_bytes);
    create_pda(admin, auction, program_id, SIZE, None, Signer::from(&seeds))?;
    write(auction, &state)
}

pub(super) fn bid(program_id: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    need(a.len() == 9 && data.len() == 49, ProgramError::InvalidInstructionData)?;
    let (bidder, mint, config, auction, previous, hook, eaml, system, holding) =
        (&a[0], &a[1], &a[2], &a[3], &a[4], &a[5], &a[6], &a[7], &a[8]);
    require_signer(bidder)?; require_writable(bidder)?; require_writable(auction)?; require_system(system)?;
    let cfg = read_config(config, mint.key(), program_id)?;
    let mut state = read(auction, mint.key(), program_id)?;
    need(cfg.admin == state.admin, UNAUTHORIZED)?;
    if state.round != u64_at(data, 1)? {
        pinocchio::log::sol_log("CAPTAINHOOK.FUN: that auction round is over. Refresh for the live round.");
        return Err(STALE_ROUND);
    }
    let now = Clock::get()?.unix_timestamp;
    if state.ends != 0 && now >= state.ends {
        pinocchio::log::sol_log("CAPTAINHOOK.FUN: bidding closed for this round; it is awaiting settlement.");
        return Err(ROUND_ENDED);
    }
    let amount = u64_at(data, 9)?;
    let floor = minimum_next(&state)?;
    if amount < floor {
        pinocchio::log::sol_log("CAPTAINHOOK.FUN: bid is below the minimum raise over the current leader.");
        return Err(BID_TOO_LOW);
    }
    let proposed = key(data, 17)?;
    check_hook(mint.key(), hook, eaml, &proposed)?;
    // Bidders must be existing holders, checked against the real Token-2022 account.
    need(token_amount(holding, mint.key(), bidder.key())? > 0, EXISTING_HOLDER_REQUIRED)?;
    Transfer { from: bidder, to: auction, lamports: amount }.invoke()?;
    if state.bid > 0 {
        need(previous.key() == &state.bidder, BAD_BIDDER)?;
        release(auction, previous, state.bid)?;
    }
    state.ends = next_end(&state, now)?;
    state.bidder = *bidder.key(); state.bid = amount; state.hook = proposed;
    write(auction, &state)?;
    pinocchio::log::sol_log("CAPTAINHOOK.FUN: new leading bid escrowed; the previous leader was refunded.");
    Ok(())
}

pub(super) fn settle(program_id: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    need(a.len() == 9 && data.len() == 9, ProgramError::InvalidInstructionData)?;
    let (admin, mint, config, auction, recipient, hook, eaml, token_program, system) =
        (&a[0], &a[1], &a[2], &a[3], &a[4], &a[5], &a[6], &a[7], &a[8]);
    require_signer(admin)?; require_writable(mint)?; require_writable(auction)?; require_writable(recipient)?;
    require_token_program(token_program)?; require_system(system)?;
    let cfg = read_config(config, mint.key(), program_id)?;
    let mut state = read(auction, mint.key(), program_id)?;
    need(cfg.admin == *admin.key() && state.admin == *admin.key(), UNAUTHORIZED)?;
    need(state.round == u64_at(data, 1)?, STALE_ROUND)?;
    need(state.bid > 0, NO_BID)?;
    let now = Clock::get()?.unix_timestamp;
    if now < state.ends {
        pinocchio::log::sol_log("CAPTAINHOOK.FUN: this round is still live; bidders can still raise.");
        return Err(ROUND_LIVE);
    }
    need(state.recipient == *recipient.key(), UNAUTHORIZED)?;
    check_hook(mint.key(), hook, eaml, &state.hook)?;
    // CPI first: the recipient may alias the signing admin, and lamport moves
    // made before a CPI would look unbalanced to the runtime at that boundary.
    let update = spl_token_2022::extension::transfer_hook::instruction::update(
        &solana_program::pubkey::Pubkey::new_from_array(TOKEN_2022),
        &solana_program::pubkey::Pubkey::new_from_array(*mint.key()),
        &solana_program::pubkey::Pubkey::new_from_array(*admin.key()),
        &[], Some(solana_program::pubkey::Pubkey::new_from_array(state.hook)),
    ).map_err(|_| BAD_HOOK)?;
    let metas = [AccountMeta::writable(mint.key()), AccountMeta::readonly_signer(admin.key())];
    invoke(&Instruction { program_id: &TOKEN_2022, accounts: &metas, data: &update.data }, &[mint, admin])?;
    release(auction, recipient, state.bid)?;
    state.winner = state.bidder; state.won_hook = state.hook; state.paid = state.bid; state.won_at = now;
    reopen(&mut state, now)?;
    write(auction, &state)?;
    pinocchio::log::sol_log("CAPTAINHOOK.FUN: auction settled to the highest bidder; next round is live. Seller retains the literal hook authority.");
    Ok(())
}

/// Seller escape hatch for a leading hook that cannot pass the settlement
/// proof: the leader is refunded in full and a fresh round opens.
pub(super) fn void(program_id: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    need(a.len() == 5 && data.len() == 9, ProgramError::InvalidInstructionData)?;
    let (admin, mint, config, auction, bidder) = (&a[0], &a[1], &a[2], &a[3], &a[4]);
    require_signer(admin)?; require_writable(auction)?;
    let cfg = read_config(config, mint.key(), program_id)?;
    let mut state = read(auction, mint.key(), program_id)?;
    need(cfg.admin == *admin.key() && state.admin == *admin.key(), UNAUTHORIZED)?;
    need(state.round == u64_at(data, 1)?, STALE_ROUND)?;
    need(state.bid > 0, NO_BID)?;
    need(bidder.key() == &state.bidder, BAD_BIDDER)?;
    release(auction, bidder, state.bid)?;
    reopen(&mut state, Clock::get()?.unix_timestamp)?;
    write(auction, &state)?;
    pinocchio::log::sol_log("CAPTAINHOOK.FUN: round voided; the leading bid was refunded and a new round opened.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Auction {
        Auction { mint: [1; 32], admin: [2; 32], recipient: [3; 32], min_bid: 10_000_000, increment_bps: 1000,
            duration: 1800, extension: 300, round: 1, started: 1000, ends: 0, bidder: [0; 32], bid: 0, hook: [0; 32],
            winner: [0; 32], paid: 0, won_hook: [0; 32], won_at: 0 }
    }
    #[test]
    fn minimum_bid_then_ten_percent_raises() {
        let mut state = sample();
        assert_eq!(minimum_next(&state).unwrap(), 10_000_000);
        state.bid = 10_000_000;
        assert_eq!(minimum_next(&state).unwrap(), 11_000_000);
        state.bid = 15; state.increment_bps = 1;
        assert_eq!(minimum_next(&state).unwrap(), 16, "a raise always exceeds the leader");
    }
    #[test]
    fn first_bid_starts_clock_and_late_bids_extend_it() {
        let mut state = sample();
        assert_eq!(next_end(&state, 1000).unwrap(), 2800);
        state.ends = 2800;
        assert_eq!(next_end(&state, 1500).unwrap(), 2800, "early bids leave the clock alone");
        assert_eq!(next_end(&state, 2500).unwrap(), 2800, "exactly at the window edge counts as inside");
        assert_eq!(next_end(&state, 2700).unwrap(), 3000, "a late bid resets the clock to the extension");
        assert_eq!(next_end(&state, 2799).unwrap(), 3099);
    }
    #[test]
    fn terms_are_validated() {
        let mut state = sample();
        assert!(valid_terms(&state));
        state.extension = 1801; assert!(!valid_terms(&state));
        state.extension = 300; state.increment_bps = 10_001; assert!(!valid_terms(&state));
        state.increment_bps = 1000; state.min_bid = 0; assert!(!valid_terms(&state));
    }
}

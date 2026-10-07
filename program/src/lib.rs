//! CAPTAINHOOK.FUN: a Pinocchio Token-2022 existing-holder transfer gate.
//! Custom instruction and account layouts are documented in README.md.
use pinocchio::{
    account_info::AccountInfo,
    cpi::invoke,
    instruction::{AccountMeta, Instruction, Signer},
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::{Allocate, Assign, CreateAccount, Transfer};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_token_2022::extension::{
    transfer_fee::TransferFeeConfig,
    transfer_hook::{TransferHook, TransferHookAccount},
    BaseStateWithExtensions, StateWithExtensions,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;
mod auction;

#[cfg(not(feature = "no-entrypoint"))]
pinocchio::entrypoint!(process_instruction);

const TOKEN_2022: Pubkey = pinocchio_pubkey::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN: Pubkey = pinocchio_pubkey::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const CONFIG_MAGIC: &[u8; 8] = b"THOOKCFG";
const STATUS_MAGIC: &[u8; 8] = b"THOOKSTS";
const CONFIG_SIZE: usize = 8 + 4 * 32 + 3 * 8 + 1 + 16 * 32;
const STATUS_SIZE: usize = 8 + 3 * 32 + 4 + 3 * 8 + 1;
const MAX_POOLS: usize = 16;
const EXECUTE_DISCRIMINATOR: [u8; 8] = [0x69, 0x25, 0x65, 0xc5, 0x4b, 0xfb, 0x66, 0x1a];

// Stable, program-specific errors (see README.md).
const INVALID_PDA: ProgramError = ProgramError::Custom(1);
const INVALID_MINT: ProgramError = ProgramError::Custom(2);
const INVALID_TOKEN_ACCOUNT: ProgramError = ProgramError::Custom(3);
const INVALID_CONFIG: ProgramError = ProgramError::Custom(4);
const INVALID_STATUS: ProgramError = ProgramError::Custom(5);
const UNAUTHORIZED: ProgramError = ProgramError::Custom(6);
const INVALID_POOLS: ProgramError = ProgramError::Custom(7);
const INVALID_VAULT: ProgramError = ProgramError::Custom(8);
const NOT_TRANSFERRING: ProgramError = ProgramError::Custom(9);
const OVERFLOW: ProgramError = ProgramError::Custom(10);
const INVALID_AMOUNT: ProgramError = ProgramError::Custom(11);
const INSUFFICIENT_RENT_RESERVE: ProgramError = ProgramError::Custom(12);
const EXISTING_HOLDER_REQUIRED: ProgramError = ProgramError::Custom(13);

#[derive(Clone)]
struct Config {
    mint: Pubkey,
    admin: Pubkey,
    patient_zero: Pubkey,
    prize_wallet: Pubkey,
    min_infect: u64,
    vax_burn: u64,
    min_active_hold: u64,
    pools: [Pubkey; MAX_POOLS],
    pool_count: u8,
}

impl Config {
    fn is_pool(&self, owner: &Pubkey) -> bool {
        self.pools[..self.pool_count as usize].contains(owner)
    }
}

#[derive(Clone, Default)]
struct Status {
    mint: Pubkey,
    owner: Pubkey,
    parent: Pubkey,
    generation: u32,
    infected_at: i64,
    vaccinated_at: i64,
    burned: u64,
    via: u8,
}

fn need(condition: bool, error: ProgramError) -> ProgramResult {
    if condition { Ok(()) } else { Err(error) }
}
fn key(data: &[u8], at: usize) -> Result<Pubkey, ProgramError> {
    data.get(at..at + 32).and_then(|x| x.try_into().ok()).ok_or(ProgramError::InvalidInstructionData)
}
fn u64_at(data: &[u8], at: usize) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(data.get(at..at + 8).and_then(|x| x.try_into().ok()).ok_or(ProgramError::InvalidInstructionData)?))
}
fn i64_at(data: &[u8], at: usize) -> Result<i64, ProgramError> {
    Ok(i64::from_le_bytes(data.get(at..at + 8).and_then(|x| x.try_into().ok()).ok_or(ProgramError::InvalidAccountData)?))
}
fn pda(info: &AccountInfo, seeds: &[&[u8]], program_id: &Pubkey) -> Result<u8, ProgramError> {
    let (expected, bump) = find_program_address(seeds, program_id);
    need(info.key() == &expected, INVALID_PDA)?;
    Ok(bump)
}
fn require_system(info: &AccountInfo) -> ProgramResult {
    need(info.key() == &pinocchio_system::ID, ProgramError::IncorrectProgramId)
}
fn require_token_program(info: &AccountInfo) -> ProgramResult {
    need(info.key() == &TOKEN_2022, ProgramError::IncorrectProgramId)
}
fn require_signer(info: &AccountInfo) -> ProgramResult {
    need(info.is_signer(), ProgramError::MissingRequiredSignature)
}
fn require_writable(info: &AccountInfo) -> ProgramResult {
    need(info.is_writable(), ProgramError::InvalidAccountData)
}

fn read_config(info: &AccountInfo, mint: &Pubkey, program_id: &Pubkey) -> Result<Config, ProgramError> {
    pda(info, &[b"config", mint], program_id)?;
    need(info.owner() == program_id && info.data_len() == CONFIG_SIZE, INVALID_CONFIG)?;
    let data = info.try_borrow_data()?;
    need(&data[..8] == CONFIG_MAGIC, INVALID_CONFIG)?;
    let pool_count = data[160];
    need(pool_count as usize <= MAX_POOLS, INVALID_CONFIG)?;
    let mut pools = [[0u8; 32]; MAX_POOLS];
    for (i, pool) in pools.iter_mut().enumerate() {
        pool.copy_from_slice(&data[161 + i * 32..193 + i * 32]);
    }
    let cfg = Config {
        mint: key(&data, 8)?, admin: key(&data, 40)?, patient_zero: key(&data, 72)?,
        prize_wallet: key(&data, 104)?, min_infect: u64_at(&data, 136)?,
        vax_burn: u64_at(&data, 144)?, min_active_hold: u64_at(&data, 152)?,
        pool_count, pools,
    };
    need(&cfg.mint == mint && cfg.min_infect > 0 && cfg.vax_burn > 0 && cfg.min_active_hold > 0, INVALID_CONFIG)?;
    Ok(cfg)
}
fn write_config(info: &AccountInfo, cfg: &Config, program_id: &Pubkey) -> ProgramResult {
    need(info.owner() == program_id && info.data_len() == CONFIG_SIZE && info.is_writable(), INVALID_CONFIG)?;
    let mut data = info.try_borrow_mut_data()?;
    data[..8].copy_from_slice(CONFIG_MAGIC);
    data[8..40].copy_from_slice(&cfg.mint);
    data[40..72].copy_from_slice(&cfg.admin);
    data[72..104].copy_from_slice(&cfg.patient_zero);
    data[104..136].copy_from_slice(&cfg.prize_wallet);
    data[136..144].copy_from_slice(&cfg.min_infect.to_le_bytes());
    data[144..152].copy_from_slice(&cfg.vax_burn.to_le_bytes());
    data[152..160].copy_from_slice(&cfg.min_active_hold.to_le_bytes());
    data[160] = cfg.pool_count;
    for (i, pool) in cfg.pools.iter().enumerate() {
        data[161 + i * 32..193 + i * 32].copy_from_slice(pool);
    }
    Ok(())
}
fn status_is_uninitialized(info: &AccountInfo) -> bool {
    info.owner() == &pinocchio_system::ID && info.data_is_empty()
}
fn read_status(info: &AccountInfo, mint: &Pubkey, owner: &Pubkey, program_id: &Pubkey) -> Result<Option<Status>, ProgramError> {
    pda(info, &[b"status", mint, owner], program_id)?;
    // An uninitialized PDA can already hold lamports: anyone can dust it.
    // Treat any empty, system-owned account at the correct PDA as uninitialized.
    if status_is_uninitialized(info) {
        return Ok(None);
    }
    need(info.owner() == program_id && info.data_len() == STATUS_SIZE, INVALID_STATUS)?;
    let data = info.try_borrow_data()?;
    need(&data[..8] == STATUS_MAGIC && &data[8..40] == mint && &data[40..72] == owner, INVALID_STATUS)?;
    Ok(Some(Status {
        mint: *mint, owner: *owner, parent: key(&data, 72)?,
        generation: u32::from_le_bytes(data[104..108].try_into().map_err(|_| INVALID_STATUS)?),
        infected_at: i64_at(&data, 108)?, vaccinated_at: i64_at(&data, 116)?,
        burned: u64_at(&data, 124)?, via: data[132],
    }))
}
fn write_status(info: &AccountInfo, status: &Status, program_id: &Pubkey) -> ProgramResult {
    need(info.owner() == program_id && info.data_len() == STATUS_SIZE && info.is_writable(), INVALID_STATUS)?;
    let mut data = info.try_borrow_mut_data()?;
    data[..8].copy_from_slice(STATUS_MAGIC);
    data[8..40].copy_from_slice(&status.mint);
    data[40..72].copy_from_slice(&status.owner);
    data[72..104].copy_from_slice(&status.parent);
    data[104..108].copy_from_slice(&status.generation.to_le_bytes());
    data[108..116].copy_from_slice(&status.infected_at.to_le_bytes());
    data[116..124].copy_from_slice(&status.vaccinated_at.to_le_bytes());
    data[124..132].copy_from_slice(&status.burned.to_le_bytes());
    data[132] = status.via;
    Ok(())
}
fn token_owner(info: &AccountInfo, mint: &Pubkey) -> Result<Pubkey, ProgramError> {
    need(info.owner() == &TOKEN_2022, INVALID_TOKEN_ACCOUNT)?;
    let data = info.try_borrow_data()?;
    let account = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&data).map_err(|_| INVALID_TOKEN_ACCOUNT)?;
    need(account.base.mint.to_bytes() == *mint, INVALID_TOKEN_ACCOUNT)?;
    Ok(account.base.owner.to_bytes())
}
fn token_amount(info: &AccountInfo, mint: &Pubkey, owner: &Pubkey) -> Result<u64, ProgramError> {
    need(info.owner() == &TOKEN_2022, INVALID_TOKEN_ACCOUNT)?;
    let data = info.try_borrow_data()?;
    let account = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&data).map_err(|_| INVALID_TOKEN_ACCOUNT)?;
    need(account.base.mint.to_bytes() == *mint && account.base.owner.to_bytes() == *owner, INVALID_TOKEN_ACCOUNT)?;
    Ok(account.base.amount)
}

fn require_existing_holder(
    source: &AccountInfo, destination: &AccountInfo, proof: Option<&AccountInfo>,
    mint: &Pubkey, source_owner: &Pubkey, dest_owner: &Pubkey, amount: u64, received: u64,
) -> ProgramResult {
    // Token-2022 calls Execute AFTER updating balances. Subtract the received
    // amount so the very transfer being checked can never establish eligibility.
    let destination_before = token_amount(destination, mint, dest_owner)?.checked_sub(received).ok_or(INVALID_AMOUNT)?;
    let mut already_held = destination_before > 0;
    if source_owner == dest_owner {
        let source_balance = token_amount(source, mint, source_owner)?;
        already_held |= if source.key() == destination.key() {
            source_balance > 0
        } else {
            source_balance.checked_add(amount).ok_or(OVERFLOW)? > 0
        };
    }
    if let Some(proof) = proof {
        let expected = find_program_address(&[dest_owner, &TOKEN_2022, mint], &ASSOCIATED_TOKEN).0;
        need(proof.key() == &expected, INVALID_TOKEN_ACCOUNT)?;
        // A separate, already-funded ATA proves ownership when receiving into
        // another token account. Never count the destination's post-transfer balance.
        if proof.key() != destination.key() && !proof.data_is_empty() {
            already_held |= token_amount(proof, mint, dest_owner)? > 0;
        }
    }
    if !already_held {
        pinocchio::log::sol_log("CAPTAINHOOK.FUN: existing holders only. Recipient must already hold this mint BEFORE the transfer:");
        pinocchio::pubkey::log(mint);
        pinocchio::log::sol_log("Ineligible recipient:");
        pinocchio::pubkey::log(dest_owner);
        return Err(EXISTING_HOLDER_REQUIRED);
    }
    Ok(())
}
fn assert_transferring(info: &AccountInfo) -> ProgramResult {
    let data = info.try_borrow_data()?;
    let account = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&data).map_err(|_| INVALID_TOKEN_ACCOUNT)?;
    let hook = account.get_extension::<TransferHookAccount>().map_err(|_| NOT_TRANSFERRING)?;
    need(bool::from(hook.transferring), NOT_TRANSFERRING)
}
fn mint_decimals_and_fee(info: &AccountInfo, amount: u64) -> Result<(u8, u64), ProgramError> {
    need(info.owner() == &TOKEN_2022, INVALID_MINT)?;
    let data = info.try_borrow_data()?;
    let mint = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data).map_err(|_| INVALID_MINT)?;
    let fee = match mint.get_extension::<TransferFeeConfig>() {
        Ok(config) => config.calculate_epoch_fee(Clock::get()?.epoch, amount).ok_or(OVERFLOW)?,
        Err(_) => 0,
    };
    Ok((mint.base.decimals, amount.checked_sub(fee).ok_or(OVERFLOW)?))
}
fn validate_pools(pools: &[Pubkey]) -> ProgramResult {
    need(pools.len() <= MAX_POOLS, INVALID_POOLS)?;
    for (i, key) in pools.iter().enumerate() {
        need(*key != [0; 32] && !pools[..i].contains(key), INVALID_POOLS)?;
    }
    Ok(())
}
fn parse_pools(data: &[u8], at: usize) -> Result<([Pubkey; MAX_POOLS], u8), ProgramError> {
    let count = *data.get(at).ok_or(ProgramError::InvalidInstructionData)? as usize;
    need(count <= MAX_POOLS && data.len() == at + 1 + 32 * count, INVALID_POOLS)?;
    let mut pools = [[0; 32]; MAX_POOLS];
    for i in 0..count { pools[i] = key(data, at + 1 + 32 * i)?; }
    validate_pools(&pools[..count])?;
    Ok((pools, count as u8))
}
fn create_pda<'a>(payer: &AccountInfo, target: &AccountInfo, program_id: &Pubkey, space: usize, payer_signer: Option<Signer<'a, 'a>>, target_signer: Signer<'a, 'a>) -> ProgramResult {
    require_writable(payer)?;
    require_writable(target)?;
    need(target.owner() == &pinocchio_system::ID && target.data_is_empty(), INVALID_PDA)?;
    let required = Rent::get()?.minimum_balance(space);
    let additional = required.saturating_sub(target.lamports());
    if target.lamports() == 0 {
        let create = CreateAccount { from: payer, to: target, lamports: required, space: space as u64, owner: program_id };
        if let Some(payer_signer) = payer_signer {
            create.invoke_signed(&[payer_signer, target_signer])
        } else {
            create.invoke_signed(&[target_signer])
        }
    } else {
        if additional > 0 {
            let transfer = Transfer { from: payer, to: target, lamports: additional };
            if let Some(payer_signer) = payer_signer {
                transfer.invoke_signed(&[payer_signer])?;
            } else { transfer.invoke()?; }
        }
        Allocate { account: target, space: space as u64 }.invoke_signed(&[target_signer.clone()])?;
        Assign { account: target, owner: program_id }.invoke_signed(&[target_signer])
    }
}
fn create_status(program_id: &Pubkey, vault: &AccountInfo, target: &AccountInfo, mint: &Pubkey, owner: &Pubkey) -> ProgramResult {
    let vault_bump = pda(vault, &[b"rent-vault", mint], program_id)?;
    let status_bump = pda(target, &[b"status", mint, owner], program_id)?;
    need(vault.owner() == &pinocchio_system::ID && vault.data_is_empty(), INVALID_VAULT)?;
    require_status_reserve(vault, target)?;
    let vault_bump_bytes = [vault_bump];
    let status_bump_bytes = [status_bump];
    let vault_seeds = pinocchio::seeds!(b"rent-vault", mint, &vault_bump_bytes);
    let status_seeds = pinocchio::seeds!(b"status", mint, owner, &status_bump_bytes);
    create_pda(vault, target, program_id, STATUS_SIZE, Some(Signer::from(&vault_seeds)), Signer::from(&status_seeds))
        .map_err(|_| INVALID_VAULT)?;
    write_status(target, &Status { mint: *mint, owner: *owner, ..Status::default() }, program_id)
}

fn require_status_reserve(vault: &AccountInfo, target: &AccountInfo) -> ProgramResult {
    let rent = Rent::get()?;
    let needed = rent.minimum_balance(STATUS_SIZE).saturating_sub(target.lamports());
    // Keep the system-owned vault rent exempt after creating the status.
    let available = vault.lamports().saturating_sub(rent.minimum_balance(0));
    if available < needed {
        pinocchio::log::sol_log("CAPTAINHOOK.FUN: legacy status rent depleted. Please send SOL to this rent vault, then retry:");
        pinocchio::pubkey::log(vault.key());
        pinocchio::log::sol_log("Required / spendable lamports (hex):");
        pinocchio::log::sol_log_64(needed, available, 0, 0, 0);
        return Err(INSUFFICIENT_RENT_RESERVE);
    }
    Ok(())
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() == 16 && data[..8] == EXECUTE_DISCRIMINATOR {
        return execute(program_id, accounts, u64_at(data, 8)?);
    }
    match data.first() {
        Some(0) => initialize_config(program_id, accounts, data),
        Some(1) => initialize_extra_meta_list(program_id, accounts),
        Some(2) => fund_vault(program_id, accounts, data),
        Some(3) => set_pools(program_id, accounts, data),
        Some(4) => burn_and_vaccinate(program_id, accounts, data),
        Some(5) if data.len() == 1 => update_extra_meta_list(program_id, accounts),
        Some(6) => auction::initialize(program_id, accounts, data),
        Some(7) => auction::bid(program_id, accounts, data),
        Some(8) => auction::settle(program_id, accounts, data),
        Some(9) => auction::void(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[inline(never)]
fn initialize_config(program_id: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    need(a.len() == 4 && data.len() >= 90, ProgramError::NotEnoughAccountKeys)?;
    let (admin, mint, config, system) = (&a[0], &a[1], &a[2], &a[3]);
    require_signer(admin)?; require_writable(admin)?; require_system(system)?;
    need(mint.owner() == &TOKEN_2022, INVALID_MINT)?;
    let mint_data = mint.try_borrow_data()?;
    let mint_state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data).map_err(|_| INVALID_MINT)?;
    let hook = mint_state.get_extension::<TransferHook>().map_err(|_| INVALID_MINT)?;
    let hook_admin: Option<solana_program::pubkey::Pubkey> = hook.authority.into();
    need(hook_admin.map(|x| x.to_bytes()) == Some(*admin.key()), UNAUTHORIZED)?;
    drop(mint_data);
    let bump = pda(config, &[b"config", mint.key()], program_id)?;
    need(config.owner() == &pinocchio_system::ID && config.data_is_empty(), INVALID_CONFIG)?;
    let patient_zero = key(data, 1)?;
    let prize_wallet = key(data, 33)?;
    let min_infect = u64_at(data, 65)?;
    let vax_burn = u64_at(data, 73)?;
    let min_active_hold = u64_at(data, 81)?;
    need(patient_zero != [0; 32] && prize_wallet != [0; 32] && min_infect > 0 && vax_burn > 0 && min_active_hold > 0, INVALID_CONFIG)?;
    let (pools, pool_count) = parse_pools(data, 89)?;
    let bump_bytes = [bump];
    let seeds = pinocchio::seeds!(b"config", mint.key(), &bump_bytes);
    create_pda(admin, config, program_id, CONFIG_SIZE, None, Signer::from(&seeds))?;
    write_config(config, &Config { mint: *mint.key(), admin: *admin.key(), patient_zero, prize_wallet, min_infect, vax_burn, min_active_hold, pools, pool_count }, program_id)
}

#[cfg(test)]
fn status_meta(account_index: u8, writable: bool) -> Result<ExtraAccountMeta, ProgramError> {
    ExtraAccountMeta::new_with_seeds(&[
        Seed::Literal { bytes: b"status".to_vec() },
        Seed::AccountKey { index: 1 },
        Seed::AccountData { account_index, data_index: 32, length: 32 },
    ], false, writable).map_err(|_| ProgramError::InvalidAccountData)
}
fn extra_metas(config: &Pubkey, vault: &Pubkey) -> Result<Vec<ExtraAccountMeta>, ProgramError> {
    let _ = (config, vault); // Preserve the operator instruction wire format.
    use solana_program::pubkey::Pubkey as SolPubkey;
    let static_meta = |key: &Pubkey, writable| ExtraAccountMeta::new_with_pubkey(
        &SolPubkey::new_from_array(*key), false, writable,
    ).map_err(|_| ProgramError::InvalidAccountData);
    Ok(vec![
        static_meta(&TOKEN_2022, false)?, static_meta(&ASSOCIATED_TOKEN, false)?,
        ExtraAccountMeta::new_external_pda_with_seeds(6, &[
            Seed::AccountData { account_index: 2, data_index: 32, length: 32 },
            Seed::AccountKey { index: 5 }, Seed::AccountKey { index: 1 },
        ], false, false).map_err(|_| ProgramError::InvalidAccountData)?,
    ])
}
#[inline(never)]
fn initialize_extra_meta_list(program_id: &Pubkey, a: &[AccountInfo]) -> ProgramResult {
    need(a.len() == 5, ProgramError::NotEnoughAccountKeys)?;
    let (admin, mint, config_info, meta, system) = (&a[0], &a[1], &a[2], &a[3], &a[4]);
    require_signer(admin)?; require_writable(admin)?; require_system(system)?;
    let cfg = read_config(config_info, mint.key(), program_id)?;
    need(cfg.admin == *admin.key(), UNAUTHORIZED)?;
    let bump = pda(meta, &[b"extra-account-metas", mint.key()], program_id)?;
    need(meta.owner() == &pinocchio_system::ID && meta.data_is_empty(), INVALID_PDA)?;
    let (vault_key, _) = find_program_address(&[b"rent-vault", mint.key()], program_id);
    let metas = extra_metas(config_info.key(), &vault_key)?;
    let space = ExtraAccountMetaList::size_of(metas.len()).map_err(|_| ProgramError::InvalidAccountData)?;
    let bump_bytes = [bump];
    let seeds = pinocchio::seeds!(b"extra-account-metas", mint.key(), &bump_bytes);
    create_pda(admin, meta, program_id, space, None, Signer::from(&seeds))?;
    let mut out = meta.try_borrow_mut_data()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut out, &metas).map_err(|_| ProgramError::InvalidAccountData)
}
#[inline(never)]
fn update_extra_meta_list(program_id: &Pubkey, a: &[AccountInfo]) -> ProgramResult {
    need(a.len() == 5, ProgramError::NotEnoughAccountKeys)?;
    let (admin, mint, config_info, meta, system) = (&a[0], &a[1], &a[2], &a[3], &a[4]);
    require_signer(admin)?; require_writable(admin)?; require_writable(meta)?; require_system(system)?;
    let cfg = read_config(config_info, mint.key(), program_id)?;
    need(cfg.admin == *admin.key(), UNAUTHORIZED)?;
    pda(meta, &[b"extra-account-metas", mint.key()], program_id)?;
    need(meta.owner() == program_id && meta.data_len() >= 16, INVALID_PDA)?;
    let (vault, _) = find_program_address(&[b"rent-vault", mint.key()], program_id);
    let metas = extra_metas(config_info.key(), &vault)?;
    let space = ExtraAccountMetaList::size_of(metas.len()).map_err(|_| ProgramError::InvalidAccountData)?;
    let additional = Rent::get()?.minimum_balance(space).saturating_sub(meta.lamports());
    if additional > 0 { Transfer { from: admin, to: meta, lamports: additional }.invoke()?; }
    meta.resize(space)?;
    let mut data = meta.try_borrow_mut_data()?;
    data.fill(0);
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)
        .map_err(|_| ProgramError::InvalidAccountData)
}
#[inline(never)]
fn fund_vault(program_id: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    need(a.len() == 5 && data.len() == 9, ProgramError::InvalidInstructionData)?;
    let (funder, mint, config, vault, system) = (&a[0], &a[1], &a[2], &a[3], &a[4]);
    require_signer(funder)?; require_writable(funder)?; require_writable(vault)?; require_system(system)?;
    read_config(config, mint.key(), program_id)?;
    pda(vault, &[b"rent-vault", mint.key()], program_id)?;
    need(vault.owner() == &pinocchio_system::ID && vault.data_is_empty(), INVALID_VAULT)?;
    let amount = u64_at(data, 1)?;
    need(amount > 0, INVALID_AMOUNT)?;
    Transfer { from: funder, to: vault, lamports: amount }.invoke()
}
#[inline(never)]
fn set_pools(program_id: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    need(a.len() == 3 && data.len() >= 2, ProgramError::InvalidInstructionData)?;
    let (admin, mint, config) = (&a[0], &a[1], &a[2]);
    require_signer(admin)?;
    let mut cfg = read_config(config, mint.key(), program_id)?;
    need(cfg.admin == *admin.key(), UNAUTHORIZED)?;
    let (pools, count) = parse_pools(data, 1)?;
    cfg.pools = pools; cfg.pool_count = count;
    write_config(config, &cfg, program_id)
}
#[inline(never)]
fn execute(program_id: &Pubkey, a: &[AccountInfo], amount: u64) -> ProgramResult {
    // The old EAML is accepted during migration, but the holder gate is always
    // enforced. The new EAML additionally supplies the recipient's canonical ATA.
    need(a.len() == 8 || a.len() == 10 || a.len() == 13, ProgramError::NotEnoughAccountKeys)?;
    let (source, mint, destination, meta) = (&a[0], &a[1], &a[2], &a[4]);
    pda(meta, &[b"extra-account-metas", mint.key()], program_id)?;
    need(meta.owner() == program_id && meta.data_len() >= 8, INVALID_PDA)?;
    let source_owner = token_owner(source, mint.key())?;
    let dest_owner = token_owner(destination, mint.key())?;
    assert_transferring(source)?;
    let (_, received) = mint_decimals_and_fee(mint, amount)?;
    let proof = match a.len() {
        8 => {
            require_token_program(&a[5])?;
            need(a[6].key() == &ASSOCIATED_TOKEN, ProgramError::IncorrectProgramId)?;
            Some(&a[7])
        }
        13 => {
            require_token_program(&a[10])?;
            need(a[11].key() == &ASSOCIATED_TOKEN, ProgramError::IncorrectProgramId)?;
            Some(&a[12])
        }
        _ => None,
    };
    require_existing_holder(source, destination, proof, mint.key(), &source_owner, &dest_owner, amount, received)
}
#[cfg(test)]
fn infection_source(cfg: &Config, source: &Pubkey, status: Option<&Status>) -> Option<(Pubkey, u32, u8)> {
    if cfg.is_pool(source) { return Some((*source, 2, 1)); }
    if source == &cfg.patient_zero { return Some((*source, 1, 2)); }
    let status = status?;
    if status.infected_at == 0 || status.vaccinated_at != 0 { return None; }
    status.generation.checked_add(1).map(|generation| (*source, generation, 2))
}
#[inline(never)]
fn burn_and_vaccinate(program_id: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    need(a.len() == 8 && data.len() == 9, ProgramError::InvalidInstructionData)?;
    let (source, mint, authority, config_info, status_info, vault, token_program, system) =
        (&a[0], &a[1], &a[2], &a[3], &a[4], &a[5], &a[6], &a[7]);
    require_signer(authority)?; require_writable(source)?; require_writable(mint)?; require_system(system)?; require_token_program(token_program)?;
    let amount = u64_at(data, 1)?;
    need(amount > 0, INVALID_AMOUNT)?;
    let cfg = read_config(config_info, mint.key(), program_id)?;
    let owner = token_owner(source, mint.key())?;
    need(!cfg.is_pool(&owner), UNAUTHORIZED)?;
    let (decimals, _) = mint_decimals_and_fee(mint, 0)?;
    pda(status_info, &[b"status", mint.key(), &owner], program_id)?;
    pda(vault, &[b"rent-vault", mint.key()], program_id)?;
    let existing = read_status(status_info, mint.key(), &owner, program_id)?;
    if existing.is_none() { require_status_reserve(vault, status_info)?; }
    // BurnChecked: token instruction tag 15, amount, decimals. The Token-2022 program
    // validates owner/delegate authority and the token account balance.
    let mut burn_data = [0u8; 10];
    burn_data[0] = 15; burn_data[1..9].copy_from_slice(&amount.to_le_bytes()); burn_data[9] = decimals;
    let metas = [AccountMeta::writable(source.key()), AccountMeta::writable(mint.key()), AccountMeta::readonly_signer(authority.key())];
    let instruction = Instruction { program_id: &TOKEN_2022, accounts: &metas, data: &burn_data };
    invoke(&instruction, &[source, mint, authority])?;
    if existing.is_none() { create_status(program_id, vault, status_info, mint.key(), &owner)?; }
    let mut status = read_status(status_info, mint.key(), &owner, program_id)?.ok_or(INVALID_STATUS)?;
    status.burned = status.burned.checked_add(amount).ok_or(OVERFLOW)?;
    let now = Clock::get()?.unix_timestamp;
    let mut event = [0u8; 90];
    event[0] = 2; event[1..33].copy_from_slice(mint.key()); event[33..65].copy_from_slice(&owner);
    event[65..73].copy_from_slice(&amount.to_le_bytes()); event[73..81].copy_from_slice(&status.burned.to_le_bytes());
    event[81..89].copy_from_slice(&now.to_le_bytes());
    pinocchio::log::sol_log_data(&[b"THOOOK_EVENT_V1", &event[..89]]);
    if status.infected_at != 0 && status.vaccinated_at == 0 && owner != cfg.patient_zero && status.burned >= cfg.vax_burn {
        status.vaccinated_at = now.max(1);
        let mut vaccinated = [0u8; 81];
        vaccinated[0] = 3; vaccinated[1..33].copy_from_slice(mint.key()); vaccinated[33..65].copy_from_slice(&owner);
        vaccinated[65..73].copy_from_slice(&status.burned.to_le_bytes()); vaccinated[73..81].copy_from_slice(&now.to_le_bytes());
        pinocchio::log::sol_log_data(&[b"THOOOK_EVENT_V1", &vaccinated]);
    }
    write_status(status_info, &status, program_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn infection_sources_obey_vaccination_and_generation() {
        let pool = [1u8; 32];
        let patient_zero = [2u8; 32];
        let source = [3u8; 32];
        let mut pools = [[0; 32]; MAX_POOLS]; pools[0] = pool;
        let cfg = Config { mint: [4;32], admin: [5;32], patient_zero, prize_wallet: [6;32], min_infect: 1, vax_burn: 2, min_active_hold: 1, pools, pool_count: 1 };
        assert_eq!(infection_source(&cfg, &pool, None), Some((pool, 2, 1)));
        assert_eq!(infection_source(&cfg, &patient_zero, None), Some((patient_zero, 1, 2)));
        let mut status = Status { infected_at: 1, generation: 3, ..Status::default() };
        assert_eq!(infection_source(&cfg, &source, Some(&status)), Some((source, 4, 2)));
        status.vaccinated_at = 2;
        assert_eq!(infection_source(&cfg, &source, Some(&status)), None);
    }
    #[test]
    fn duplicate_pool_owners_rejected() {
        assert!(validate_pools(&[[1;32], [1;32]]).is_err());
        assert!(validate_pools(&[[1;32], [2;32]]).is_ok());
    }

    #[test]
    fn eaml_status_seeds_follow_token_account_owners() {
        use solana_program::pubkey::Pubkey as SolPubkey;
        let program = SolPubkey::new_from_array([9; 32]);
        let mint = SolPubkey::new_from_array([8; 32]);
        let source = SolPubkey::new_from_array([7; 32]);
        let destination = SolPubkey::new_from_array([6; 32]);
        let source_owner = SolPubkey::new_from_array([5; 32]);
        let dest_owner = SolPubkey::new_from_array([4; 32]);
        let mut source_data = [0u8; 165];
        source_data[32..64].copy_from_slice(source_owner.as_ref());
        let mut destination_data = [0u8; 165];
        destination_data[32..64].copy_from_slice(dest_owner.as_ref());
        let accounts = [
            (source, Some(source_data.as_slice())),
            (mint, None),
            (destination, Some(destination_data.as_slice())),
        ];
        for (index, owner, writable) in [(0, source_owner, false), (2, dest_owner, true)] {
            let resolved = status_meta(index, writable).unwrap().resolve(&[], &program, |i| {
                accounts.get(i).map(|(key, data)| (key, *data))
            }).unwrap();
            let expected = SolPubkey::find_program_address(
                &[b"status", mint.as_ref(), owner.as_ref()], &program,
            ).0;
            assert_eq!(resolved.pubkey, expected);
            assert_eq!(resolved.is_writable, writable);
        }
    }
}

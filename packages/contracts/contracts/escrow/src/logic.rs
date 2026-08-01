//! # Escrow — Business Logic
//!
//! State-machine transitions, access-control guards, and RBAC helpers.
//! All functions follow the Checks → Effects → Interactions (CEI) pattern.
//! Token transfers (Interactions) only happen after storage is updated (Effects).

use soroban_sdk::{symbol_short, token, Address, BytesN, Env, Symbol, Vec};

use crate::storage::{
    self, load_escrow, load_escrow_list, load_role_members, save_escrow, save_escrow_list,
    save_role_members, EscrowRecord, EscrowState,
};

// =============================================================================
// Roles
// =============================================================================

pub const ROLE_ADMIN: &str = "admin";
pub const ROLE_ARBITRATOR: &str = "arbitrator";
pub const ROLE_UPGRADER: &str = "upgrader";
pub const ROLE_PAUSER: &str = "pauser";

pub const ROLE_ADMIN_ID: u64 = 0;
pub const ROLE_ARBITRATOR_ID: u64 = 1;
pub const ROLE_UPGRADER_ID: u64 = 2;
pub const ROLE_PAUSER_ID: u64 = 3;

/// Map a role symbol to its compact storage id.
pub fn role_to_id(env: &Env, role: &Symbol) -> u64 {
    if *role == Symbol::new(env, ROLE_ADMIN) {
        ROLE_ADMIN_ID
    } else if *role == Symbol::new(env, ROLE_ARBITRATOR) {
        ROLE_ARBITRATOR_ID
    } else if *role == Symbol::new(env, ROLE_UPGRADER) {
        ROLE_UPGRADER_ID
    } else if *role == Symbol::new(env, ROLE_PAUSER) {
        ROLE_PAUSER_ID
    } else {
        u64::MAX
    }
}

// =============================================================================
// RBAC helpers
// =============================================================================

/// Assert `caller` holds `role` and has signed the transaction.
///
/// # Panics
/// - `"Missing role"` if the membership check fails.
pub fn require_role(env: &Env, role: &Symbol, caller: &Address) {
    caller.require_auth();
    let id = role_to_id(env, role);
    let members = load_role_members(env, id);
    assert!(members.iter().any(|m| m == *caller), "Missing role");
}

/// Assert the contract is not paused.
///
/// # Panics
/// - `"Contract is paused"`.
pub fn require_not_paused(env: &Env) {
    assert!(!storage::is_paused(env), "Contract is paused");
}

// =============================================================================
// Initialisation
// =============================================================================

/// Bootstrap the contract storage.
///
/// # Panics
/// - `"Already initialized"` if called more than once.
pub fn do_initialize(env: &Env, admin: &Address) {
    assert!(!storage::is_initialized(env), "Already initialized");

    storage::set_initialized(env);
    storage::save_admin(env, admin);
    env.storage()
        .persistent()
        .set(&storage::DataKey::SchemaVersion, &1u32);

    let mut members: Vec<Address> = Vec::new(env);
    members.push_back(admin.clone());
    save_role_members(env, ROLE_ADMIN_ID, &members);

    env.events()
        .publish((symbol_short!("Init"), admin.clone()), 1u32);
}

// =============================================================================
// Escrow lifecycle
// =============================================================================

/// Create a new escrow and lock `amount` tokens.
///
/// The depositor must have approved the contract to spend `amount` tokens.
///
/// # Panics
/// - `"Contract is paused"` if paused.
/// - `"Escrow already exists"` if `id` is already registered.
/// - `"amount must be positive"` if `amount <= 0`.
/// - `"expiry must be in future"` if `expiry <= current timestamp`.
pub fn do_create(
    env: &Env,
    depositor: &Address,
    beneficiary: Address,
    token_addr: Address,
    id: Symbol,
    amount: i128,
    expiry: u64,
) {
    // --- Checks ---
    require_not_paused(env);
    depositor.require_auth();
    assert!(amount > 0, "amount must be positive");
    assert!(expiry > env.ledger().timestamp(), "expiry must be in future");
    assert!(load_escrow(env, &id).is_none(), "Escrow already exists");

    // --- Effects ---
    let record = EscrowRecord {
        id: id.clone(),
        depositor: depositor.clone(),
        beneficiary: beneficiary.clone(),
        token: token_addr.clone(),
        amount,
        expiry,
        state: EscrowState::Active,
        created_at: env.ledger().sequence(),
        updated_at: env.ledger().sequence(),
    };
    save_escrow(env, &record);

    let mut list = load_escrow_list(env);
    list.push_back(id.clone());
    save_escrow_list(env, &list);

    // --- Interactions ---
    let token = token::Client::new(env, &token_addr);
    token.transfer(depositor, &env.current_contract_address(), &amount);

    env.events().publish(
        (symbol_short!("Created"), id),
        (depositor.clone(), beneficiary, amount),
    );
}

/// Release escrow funds to the beneficiary.
///
/// Only the depositor or an admin may release.
///
/// # Panics
/// - `"Escrow not found"` if id does not exist.
/// - `"Not authorized"` if caller is neither depositor nor admin.
/// - `"Escrow not active"` if state is not `Active`.
pub fn do_release(env: &Env, caller: &Address, id: Symbol) {
    // --- Checks ---
    require_not_paused(env);
    caller.require_auth();

    let mut record = load_escrow(env, &id).expect("Escrow not found");
    assert!(record.state == EscrowState::Active, "Escrow not active");

    let is_depositor = record.depositor == *caller;
    let is_admin = load_role_members(env, ROLE_ADMIN_ID)
        .iter()
        .any(|m| m == *caller);
    assert!(is_depositor || is_admin, "Not authorized");

    // --- Effects ---
    record.state = EscrowState::Released;
    record.updated_at = env.ledger().sequence();
    save_escrow(env, &record);

    // --- Interactions ---
    let token = token::Client::new(env, &record.token);
    token.transfer(&env.current_contract_address(), &record.beneficiary, &record.amount);

    env.events().publish(
        (symbol_short!("Released"), id),
        (caller.clone(), record.beneficiary, record.amount),
    );
}

/// Cancel escrow and refund funds to the depositor.
///
/// Admin may cancel at any time. The depositor may self-cancel after expiry.
///
/// # Panics
/// - `"Escrow not found"` if id does not exist.
/// - `"Escrow not active"` if already settled.
/// - `"Not authorized"` if caller lacks permission.
pub fn do_cancel(env: &Env, caller: &Address, id: Symbol) {
    // --- Checks ---
    require_not_paused(env);
    caller.require_auth();

    let mut record = load_escrow(env, &id).expect("Escrow not found");
    assert!(record.state == EscrowState::Active, "Escrow not active");

    let is_admin = load_role_members(env, ROLE_ADMIN_ID)
        .iter()
        .any(|m| m == *caller);
    let is_expired_depositor =
        record.depositor == *caller && env.ledger().timestamp() >= record.expiry;
    assert!(is_admin || is_expired_depositor, "Not authorized");

    // --- Effects ---
    record.state = EscrowState::Cancelled;
    record.updated_at = env.ledger().sequence();
    save_escrow(env, &record);

    // --- Interactions ---
    let token = token::Client::new(env, &record.token);
    token.transfer(&env.current_contract_address(), &record.depositor, &record.amount);

    env.events().publish(
        (symbol_short!("Cancelled"), id),
        (caller.clone(), record.depositor, record.amount),
    );
}

/// File a dispute on an active escrow. Either party may call.
///
/// # Panics
/// - `"Escrow not found"` if id does not exist.
/// - `"Not a party"` if caller is neither depositor nor beneficiary.
/// - `"Escrow not active"` if already settled.
pub fn do_dispute(env: &Env, caller: &Address, id: Symbol) {
    // --- Checks ---
    require_not_paused(env);
    caller.require_auth();

    let mut record = load_escrow(env, &id).expect("Escrow not found");
    let is_party =
        record.depositor == *caller || record.beneficiary == *caller;
    assert!(is_party, "Not a party");
    assert!(record.state == EscrowState::Active, "Escrow not active");

    // --- Effects ---
    record.state = EscrowState::Disputed;
    record.updated_at = env.ledger().sequence();
    save_escrow(env, &record);

    // --- Interactions ---
    env.events()
        .publish((symbol_short!("Disputed"), id), caller.clone());
}

/// Resolve a disputed escrow. Caller must hold `ROLE_ARBITRATOR`.
///
/// If `release_to_beneficiary` is `true`, funds go to the beneficiary;
/// otherwise funds are returned to the depositor.
///
/// # Panics
/// - `"Contract is paused"` if paused.
/// - `"Escrow not found"` if id does not exist.
/// - `"Missing role"` if caller does not hold `ROLE_ARBITRATOR`.
/// - `"Escrow not disputed"` if state is not `Disputed`.
pub fn do_resolve(env: &Env, caller: &Address, id: Symbol, release_to_beneficiary: bool) {
    // --- Checks ---
    require_not_paused(env);
    require_role(env, &Symbol::new(env, ROLE_ARBITRATOR), caller);

    let mut record = load_escrow(env, &id).expect("Escrow not found");
    assert!(record.state == EscrowState::Disputed, "Escrow not disputed");

    // --- Effects ---
    let recipient = if release_to_beneficiary {
        record.beneficiary.clone()
    } else {
        record.depositor.clone()
    };
    record.state = if release_to_beneficiary {
        EscrowState::Released
    } else {
        EscrowState::Cancelled
    };
    record.updated_at = env.ledger().sequence();
    save_escrow(env, &record);

    // --- Interactions ---
    let token = token::Client::new(env, &record.token);
    token.transfer(&env.current_contract_address(), &recipient, &record.amount);

    env.events().publish(
        (symbol_short!("Resolved"), id),
        (caller.clone(), recipient, release_to_beneficiary),
    );
}

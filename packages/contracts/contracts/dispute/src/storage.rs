//! Storage layer for the dispute contract.
//!
//! Owns the persisted data model — storage keys and the `Dispute` record
//! shape — plus typed get/set helpers. No validation or business rules
//! live here; see `logic.rs`.

use soroban_sdk::{contracttype, Address, Env, String, Symbol, Vec};

/// Approximate TTL extension target (~1 year at 5 s/ledger).
pub const TTL_EXTEND_TO: u32 = 535_000;
/// Extend TTL only when it drops below this threshold (~6 months).
pub const TTL_THRESHOLD: u32 = 267_500;

/// Dispute lifecycle phase.
#[contracttype]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisputeStatus {
    /// Dispute filed; tokens locked; awaiting evidence.
    Open = 0,
    /// At least one party has submitted evidence.
    Evidence = 1,
    /// Arbitrator has recorded a decision; awaiting settlement.
    Decided = 2,
    /// Tokens have been transferred; dispute closed.
    Settled = 3,
}

/// Arbitrator's decision on the dispute.
#[contracttype]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisputeOutcome {
    /// Full refund to the disputer (payer).
    RefundDisputer = 0,
    /// Full release to the respondent (worker).
    ReleaseRespondent = 1,
    /// Split: respondent gets `split_bps` share; remainder to disputer.
    Split = 2,
}

/// On-chain dispute record.
#[contracttype]
#[derive(Clone)]
pub struct Dispute {
    /// Unique identifier.
    pub id: Symbol,
    /// Party that filed the dispute and locked the tokens.
    pub disputer: Address,
    /// Party being disputed against.
    pub respondent: Address,
    /// Token contract used for the locked amount.
    pub token: Address,
    /// Total amount locked in this contract.
    pub amount: i128,
    /// Current lifecycle phase.
    pub status: DisputeStatus,
    /// Decision once `status >= Decided`; otherwise `RefundDisputer` as a placeholder.
    pub outcome: DisputeOutcome,
    /// Respondent's share in basis points (0–10 000). Only meaningful for `Split`.
    pub split_bps: u32,
    /// Arbitrator address once decided.
    pub arbitrator: Option<Address>,
    /// Unix timestamp when filed.
    pub filed_at: u64,
    /// Unix timestamp when settled (0 until settled).
    pub settled_at: u64,
    /// Off-chain evidence hash submitted by the disputer.
    pub disputer_evidence: Option<String>,
    /// Off-chain evidence hash submitted by the respondent.
    pub respondent_evidence: Option<String>,
}

/// Storage keys.
#[contracttype]
pub enum DataKey {
    /// Instance storage — admin address.
    Admin,
    /// Instance storage — paused flag.
    Paused,
    /// Persistent storage — approved arbitrators.
    Arbitrators,
    /// Persistent storage — dispute record keyed by id.
    Dispute(Symbol),
    /// Persistent storage — ordered list of all dispute ids.
    DisputeList,
}

// =============================================================================
// Admin
// =============================================================================

/// Check if admin has been set (contract initialized).
pub fn has_admin(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Admin)
}

/// Get the admin address. Panics if not initialized.
pub fn get_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("Not initialized")
}

/// Set the admin address. Instance storage doesn't use TTL, so no extension needed.
pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

// =============================================================================
// Paused flag
// =============================================================================

pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
}

// =============================================================================
// Arbitrators
// =============================================================================

pub fn get_arbitrators(env: &Env) -> Vec<Address> {
    env.storage()
        .persistent()
        .get(&DataKey::Arbitrators)
        .unwrap_or_else(|_| Vec::new(env))
}

/// Write arbitrators list. Optimized to avoid redundant operations.
pub fn set_arbitrators(env: &Env, arbitrators: &Vec<Address>) {
    let key = DataKey::Arbitrators;
    env.storage().persistent().set(&key, arbitrators);
    // Extend TTL to prevent eviction of critical access control data
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

// =============================================================================
// Disputes
// =============================================================================

pub fn has_dispute(env: &Env, id: &Symbol) -> bool {
    env.storage().persistent().has(&DataKey::Dispute(id.clone()))
}

pub fn get_dispute(env: &Env, id: &Symbol) -> Option<Dispute> {
    env.storage().persistent().get(&DataKey::Dispute(id.clone()))
}

/// Persist a dispute record and extend its TTL.
/// Combines write and TTL extension into a single operation for efficiency.
pub fn set_dispute(env: &Env, id: &Symbol, dispute: &Dispute) {
    let key = DataKey::Dispute(id.clone());
    env.storage().persistent().set(&key, dispute);
    // TTL extension is done immediately after write without redundant has() check
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

pub fn get_dispute_list(env: &Env) -> Vec<Symbol> {
    env.storage()
        .persistent()
        .get(&DataKey::DisputeList)
        .unwrap_or_else(|_| Vec::new(env))
}

/// Append a dispute id to the ordered list and extend its TTL.
/// Optimized: combines list modification and TTL extension in single operation.
pub fn push_dispute_id(env: &Env, id: &Symbol) {
    let key = DataKey::DisputeList;
    let mut list = get_dispute_list(env);

    // Only push if not already present (idempotent and prevents duplicates)
    if !list.iter().any(|x| x == id) {
        list.push_back(id.clone());
        env.storage().persistent().set(&key, &list);
        // TTL extension immediately after write
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

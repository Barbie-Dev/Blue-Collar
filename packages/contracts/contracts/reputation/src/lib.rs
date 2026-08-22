//! # BlueCollar Reputation Contract
//!
//! Tracks on-chain reputation scores for workers. Reputation is updated by
//! authorised `rep_manager` addresses only. All state-mutating functions follow
//! the Checks-Effects-Interactions (CEI) pattern to prevent reentrancy.
//!
//! ## Security audit findings & fixes (issue #1017)
//! | Finding | Severity | Fix |
//! |---------|----------|-----|
//! | `submit_review` updated storage *after* emitting an event | Medium | Move storage write before `env.events().publish` |
//! | `slash_reputation` had no `require_auth` on caller | High | Added `require_role(ROLE_REP_MANAGER, caller)` guard |
//! | `reset_reputation` reachable by any address | High | Gated behind `ROLE_ADMIN` |
//! | `award_badge` emitted event before writing badge list | Low | Reordered to write first, emit second |
//!
//! ## Access Control
//! - **Admin** (`ROLE_ADMIN`): initialise, grant/revoke roles, reset reputation, upgrade.
//! - **Rep Manager** (`ROLE_REP_MGR`): submit_review, slash_reputation, award_badge.
//! - **Anyone**: read-only queries (`get_score`, `get_reviews`, `has_badge`).
//!
//! ## CEI ordering (enforced throughout)
//! 1. **Checks** – assert preconditions (auth, bounds, state).
//! 2. **Effects** – update contract storage.
//! 3. **Interactions** – emit events (no external token calls in this contract).

#![no_std]

use bluecollar_types::storage::extend_ttl;
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, String, Symbol, Vec,
};

pub const VERSION: u32 = 1;

/// Maximum reputation score (100.00 % expressed in basis points).
pub const MAX_SCORE: u32 = 10_000;

// =============================================================================
// Roles
// =============================================================================

pub const ROLE_ADMIN: &str = "admin";
pub const ROLE_REP_MGR: &str = "rep_mgr";
pub const ROLE_UPGRADER: &str = "upgrader";
pub const ROLE_PAUSER: &str = "pauser";

const ROLE_ADMIN_ID: u64 = 0;
const ROLE_REP_MGR_ID: u64 = 1;
const ROLE_UPGRADER_ID: u64 = 2;
const ROLE_PAUSER_ID: u64 = 3;

fn role_to_id(env: &Env, role: &Symbol) -> u64 {
    if *role == Symbol::new(env, ROLE_ADMIN) {
        ROLE_ADMIN_ID
    } else if *role == Symbol::new(env, ROLE_REP_MGR) {
        ROLE_REP_MGR_ID
    } else if *role == Symbol::new(env, ROLE_UPGRADER) {
        ROLE_UPGRADER_ID
    } else if *role == Symbol::new(env, ROLE_PAUSER) {
        ROLE_PAUSER_ID
    } else {
        u64::MAX
    }
}

// =============================================================================
// Types
// =============================================================================

/// A single review record contributed by a verified reviewer.
#[contracttype]
#[derive(Clone)]
pub struct Review {
    /// Address of the reviewer (must hold `ROLE_REP_MGR`).
    pub reviewer: Address,
    /// Rating in basis points (0–10 000).
    pub rating_bps: u32,
    /// Optional short comment hash (SHA-256 of comment text), zero bytes = no comment.
    pub comment_hash: BytesN<32>,
    /// Ledger sequence number when review was submitted.
    pub ledger: u32,
}

/// Aggregated reputation record stored per worker.
#[contracttype]
#[derive(Clone)]
pub struct ReputationRecord {
    /// Current weighted score in basis points (0–10 000).
    pub score: u32,
    /// Total number of reviews received.
    pub review_count: u32,
    /// Running sum of rating_bps for average calculation.
    pub rating_sum: u64,
    /// Badges awarded to this worker (symbolic identifiers).
    pub badges: Vec<Symbol>,
    /// Ledger sequence of last update.
    pub last_updated: u32,
}

/// Storage keys.
#[contracttype]
pub enum DataKey {
    /// Instance — initialisation flag.
    Initialized,
    /// Instance — paused flag.
    Paused,
    /// Persistent — admin address.
    Admin,
    /// Persistent — role member lists keyed by compact role id.
    RoleMembers(u64),
    /// Persistent — `ReputationRecord` for a worker id.
    Reputation(Symbol),
    /// Persistent — list of `Review` entries for a worker id.
    Reviews(Symbol),
    /// Persistent — schema version for migrations.
    SchemaVersion,
}

// =============================================================================
// Contract
// =============================================================================

#[contract]
pub struct ReputationContract;

#[contractimpl]
impl ReputationContract {
    // -------------------------------------------------------------------------
    // Initialise
    // -------------------------------------------------------------------------

    /// Initialise the contract. Must be called exactly once.
    ///
    /// # Panics
    /// - `"Already initialized"` if called more than once.
    pub fn initialize(env: Env, admin: Address) {
        // --- Checks ---
        assert!(
            !env.storage().instance().has(&DataKey::Initialized),
            "Already initialized"
        );
        // --- Effects ---
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::SchemaVersion, &1u32);

        // Bootstrap ROLE_ADMIN for the initial admin.
        let role = Symbol::new(&env, ROLE_ADMIN);
        let mut members: Vec<Address> = Vec::new(&env);
        members.push_back(admin.clone());
        env.storage()
            .persistent()
            .set(&DataKey::RoleMembers(role_to_id(&env, &role)), &members);
        // --- Interactions ---
        env.events()
            .publish((symbol_short!("Init"), admin), VERSION);
    }

    // -------------------------------------------------------------------------
    // Internal RBAC helpers
    // -------------------------------------------------------------------------

    fn get_role_members(env: &Env, role: &Symbol) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::RoleMembers(role_to_id(env, role)))
            .unwrap_or(Vec::new(env))
    }

    /// Assert `caller` holds `role` and has authorised this transaction.
    ///
    /// # Panics
    /// - `"Missing role"` if `caller` is not a member of `role`.
    fn require_role(env: &Env, role: &Symbol, caller: &Address) {
        // Checks: auth first, then membership
        caller.require_auth();
        let members = Self::get_role_members(env, role);
        assert!(members.iter().any(|m| m == *caller), "Missing role");
    }

    fn require_not_paused(env: &Env) {
        assert!(
            !env.storage()
                .instance()
                .get::<_, bool>(&DataKey::Paused)
                .unwrap_or(false),
            "Contract is paused"
        );
    }

    // -------------------------------------------------------------------------
    // Role management
    // -------------------------------------------------------------------------

    /// Grant a role to an address. Caller must hold `ROLE_ADMIN`.
    pub fn grant_role(env: Env, caller: Address, role: Symbol, account: Address) {
        Self::require_role(&env, &Symbol::new(&env, ROLE_ADMIN), &caller);
        let mut members = Self::get_role_members(&env, &role);
        if !members.iter().any(|m| m == account) {
            members.push_back(account.clone());
        }
        env.storage()
            .persistent()
            .set(&DataKey::RoleMembers(role_to_id(&env, &role)), &members);
        env.events()
            .publish((symbol_short!("RlGrnt"), role), account);
    }

    /// Revoke a role from an address. Caller must hold `ROLE_ADMIN`.
    pub fn revoke_role(env: Env, caller: Address, role: Symbol, account: Address) {
        Self::require_role(&env, &Symbol::new(&env, ROLE_ADMIN), &caller);
        let members = Self::get_role_members(&env, &role);
        let mut updated: Vec<Address> = Vec::new(&env);
        for m in members.iter() {
            if m != account {
                updated.push_back(m);
            }
        }
        env.storage()
            .persistent()
            .set(&DataKey::RoleMembers(role_to_id(&env, &role)), &updated);
        env.events()
            .publish((symbol_short!("RlRevk"), role), account);
    }

    /// Check whether `account` holds `role`.
    pub fn has_role(env: Env, role: Symbol, account: Address) -> bool {
        Self::get_role_members(&env, &role)
            .iter()
            .any(|m| m == account)
    }

    // -------------------------------------------------------------------------
    // Pause / Unpause
    // -------------------------------------------------------------------------

    /// Pause the contract. Caller must hold `ROLE_PAUSER`.
    pub fn pause(env: Env, caller: Address) {
        Self::require_role(&env, &Symbol::new(&env, ROLE_PAUSER), &caller);
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((symbol_short!("Paused"), caller), ());
    }

    /// Unpause the contract. Caller must hold `ROLE_PAUSER`.
    pub fn unpause(env: Env, caller: Address) {
        Self::require_role(&env, &Symbol::new(&env, ROLE_PAUSER), &caller);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish((symbol_short!("Unpaused"), caller), ());
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    // -------------------------------------------------------------------------
    // Reputation — write (ROLE_REP_MGR only)
    // -------------------------------------------------------------------------

    /// Submit a review for a worker.
    ///
    /// Security fixes applied (issue #1017):
    /// - `caller.require_auth()` enforced via `require_role` before any state change.
    /// - Storage updated (Effects) before event emission (Interactions) — CEI ordering.
    ///
    /// # Parameters
    /// - `caller`: Must hold `ROLE_REP_MGR`.
    /// - `worker_id`: The worker's symbolic identifier.
    /// - `rating_bps`: Rating in basis points (0–10 000).
    /// - `comment_hash`: SHA-256 of the review comment (zero bytes = no comment).
    ///
    /// # Panics
    /// - `"Missing role"` if caller does not hold `ROLE_REP_MGR`.
    /// - `"Contract is paused"` if paused.
    /// - `"rating_bps out of range"` if `rating_bps > MAX_SCORE`.
    pub fn submit_review(
        env: Env,
        caller: Address,
        worker_id: Symbol,
        rating_bps: u32,
        comment_hash: BytesN<32>,
    ) {
        // --- Checks ---
        Self::require_role(&env, &Symbol::new(&env, ROLE_REP_MGR), &caller);
        Self::require_not_paused(&env);
        assert!(rating_bps <= MAX_SCORE, "rating_bps out of range");

        // --- Effects ---
        let review = Review {
            reviewer: caller.clone(),
            rating_bps,
            comment_hash,
            ledger: env.ledger().sequence(),
        };

        // Load existing record or create default.
        let mut record = Self::load_record(&env, &worker_id);
        record.review_count += 1;
        record.rating_sum = record.rating_sum.saturating_add(rating_bps as u64);
        // Weighted average: rating_sum / review_count (in bps).
        record.score = (record.rating_sum / record.review_count as u64) as u32;
        record.last_updated = env.ledger().sequence();

        // Append review to history.
        let mut reviews: Vec<Review> = env
            .storage()
            .persistent()
            .get(&DataKey::Reviews(worker_id.clone()))
            .unwrap_or(Vec::new(&env));
        reviews.push_back(review);

        // Write state before emitting events (CEI).
        Self::save_record(&env, &worker_id, &record);
        env.storage()
            .persistent()
            .set(&DataKey::Reviews(worker_id.clone()), &reviews);
        Self::extend_record_ttl(&env, &worker_id);

        // --- Interactions ---
        env.events().publish(
            (symbol_short!("Review"), worker_id),
            (caller, rating_bps, record.score),
        );
    }

    /// Slash a worker's reputation score by a fixed amount in basis points.
    ///
    /// Security fixes applied (issue #1017):
    /// - Added `require_role(ROLE_REP_MGR, caller)` — previously unguarded.
    /// - State written before event emission (CEI ordering).
    ///
    /// # Parameters
    /// - `caller`: Must hold `ROLE_REP_MGR`.
    /// - `worker_id`: Target worker.
    /// - `slash_bps`: Amount to subtract (clamped at 0).
    ///
    /// # Panics
    /// - `"Missing role"` if caller does not hold `ROLE_REP_MGR`.
    /// - `"Contract is paused"` if paused.
    /// - `"slash_bps out of range"` if `slash_bps > MAX_SCORE`.
    pub fn slash_reputation(env: Env, caller: Address, worker_id: Symbol, slash_bps: u32) {
        // --- Checks ---
        Self::require_role(&env, &Symbol::new(&env, ROLE_REP_MGR), &caller); // FIX: was missing
        Self::require_not_paused(&env);
        assert!(slash_bps <= MAX_SCORE, "slash_bps out of range");

        // --- Effects ---
        let mut record = Self::load_record(&env, &worker_id);
        record.score = record.score.saturating_sub(slash_bps);
        record.last_updated = env.ledger().sequence();
        Self::save_record(&env, &worker_id, &record); // write before emit
        Self::extend_record_ttl(&env, &worker_id);

        // --- Interactions ---
        env.events().publish(
            (symbol_short!("Slashed"), worker_id),
            (caller, slash_bps, record.score),
        );
    }

    /// Reset a worker's reputation to zero. Caller must hold `ROLE_ADMIN`.
    ///
    /// Security fix (issue #1017): previously callable by any address.
    ///
    /// # Panics
    /// - `"Missing role"` if caller does not hold `ROLE_ADMIN`.
    pub fn reset_reputation(env: Env, caller: Address, worker_id: Symbol) {
        // --- Checks ---
        Self::require_role(&env, &Symbol::new(&env, ROLE_ADMIN), &caller); // FIX: now admin-only

        // --- Effects ---
        let mut record = Self::load_record(&env, &worker_id);
        record.score = 0;
        record.review_count = 0;
        record.rating_sum = 0;
        record.last_updated = env.ledger().sequence();
        Self::save_record(&env, &worker_id, &record);
        Self::extend_record_ttl(&env, &worker_id);

        // --- Interactions ---
        env.events()
            .publish((symbol_short!("Reset"), worker_id), caller);
    }

    /// Award a badge to a worker. Caller must hold `ROLE_REP_MGR`.
    ///
    /// Security fix (issue #1017): badge list written to storage before event emission.
    ///
    /// # Panics
    /// - `"Missing role"` if caller does not hold `ROLE_REP_MGR`.
    /// - `"Contract is paused"` if paused.
    /// - `"Badge already awarded"` if worker already holds this badge.
    pub fn award_badge(env: Env, caller: Address, worker_id: Symbol, badge: Symbol) {
        // --- Checks ---
        Self::require_role(&env, &Symbol::new(&env, ROLE_REP_MGR), &caller);
        Self::require_not_paused(&env);

        let mut record = Self::load_record(&env, &worker_id);
        assert!(
            !record.badges.iter().any(|b| b == badge),
            "Badge already awarded"
        );

        // --- Effects ---
        record.badges.push_back(badge.clone()); // FIX: write before emit
        record.last_updated = env.ledger().sequence();
        Self::save_record(&env, &worker_id, &record);
        Self::extend_record_ttl(&env, &worker_id);

        // --- Interactions ---
        env.events()
            .publish((symbol_short!("Badge"), worker_id), (caller, badge));
    }

    /// Revoke a badge from a worker. Caller must hold `ROLE_REP_MGR`.
    pub fn revoke_badge(env: Env, caller: Address, worker_id: Symbol, badge: Symbol) {
        // --- Checks ---
        Self::require_role(&env, &Symbol::new(&env, ROLE_REP_MGR), &caller);
        Self::require_not_paused(&env);

        let mut record = Self::load_record(&env, &worker_id);
        let mut updated_badges: Vec<Symbol> = Vec::new(&env);
        for b in record.badges.iter() {
            if b != badge {
                updated_badges.push_back(b);
            }
        }

        // --- Effects ---
        record.badges = updated_badges;
        record.last_updated = env.ledger().sequence();
        Self::save_record(&env, &worker_id, &record);
        Self::extend_record_ttl(&env, &worker_id);

        // --- Interactions ---
        env.events()
            .publish((symbol_short!("BdgRevk"), worker_id), (caller, badge));
    }

    // -------------------------------------------------------------------------
    // Reputation — read (public)
    // -------------------------------------------------------------------------

    /// Get the current reputation score for a worker (0 if not yet rated).
    pub fn get_score(env: Env, worker_id: Symbol) -> u32 {
        Self::load_record(&env, &worker_id).score
    }

    /// Get the full reputation record for a worker.
    pub fn get_record(env: Env, worker_id: Symbol) -> ReputationRecord {
        Self::load_record(&env, &worker_id)
    }

    /// Get the full review history for a worker.
    pub fn get_reviews(env: Env, worker_id: Symbol) -> Vec<Review> {
        env.storage()
            .persistent()
            .get(&DataKey::Reviews(worker_id))
            .unwrap_or(Vec::new(&env))
    }

    /// Return `true` if the worker holds the given badge.
    pub fn has_badge(env: Env, worker_id: Symbol, badge: Symbol) -> bool {
        Self::load_record(&env, &worker_id)
            .badges
            .iter()
            .any(|b| b == badge)
    }

    /// Extend the TTL of a worker's reputation entry (permissionless).
    pub fn extend_worker_ttl(env: Env, worker_id: Symbol) {
        Self::extend_record_ttl(&env, &worker_id);
    }

    /// Get the contract admin address.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Not initialized")
    }

    // -------------------------------------------------------------------------
    // Versioning
    // -------------------------------------------------------------------------

    /// Return the event schema version.
    pub fn version(_env: Env) -> u32 {
        VERSION
    }

    // -------------------------------------------------------------------------
    // Upgrade
    // -------------------------------------------------------------------------

    /// Upgrade the contract WASM. Caller must hold `ROLE_UPGRADER`.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        Self::require_role(&env, &Symbol::new(&env, ROLE_UPGRADER), &caller);
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    fn load_record(env: &Env, worker_id: &Symbol) -> ReputationRecord {
        env.storage()
            .persistent()
            .get(&DataKey::Reputation(worker_id.clone()))
            .unwrap_or(ReputationRecord {
                score: 0,
                review_count: 0,
                rating_sum: 0,
                badges: Vec::new(env),
                last_updated: 0,
            })
    }

    fn save_record(env: &Env, worker_id: &Symbol, record: &ReputationRecord) {
        env.storage()
            .persistent()
            .set(&DataKey::Reputation(worker_id.clone()), record);
    }

    fn extend_record_ttl(env: &Env, worker_id: &Symbol) {
        extend_ttl(env, &DataKey::Reputation(worker_id.clone()));
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod test;

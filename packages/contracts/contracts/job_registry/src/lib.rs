//! # BlueCollar Job-Registry Contract
//!
//! Refactored from a monolithic `lib.rs` into three focused modules (issue #1018):
//!
//! | Module | Responsibility |
//! |--------|---------------|
//! | `storage` | All persistent/instance storage reads and writes |
//! | `logic`   | Business rules, state-machine transitions, RBAC helpers |
//! | `lib`     | Public contract entry-points — thin delegation layer only |
//!
//! The public interface is **unchanged** from the pre-refactor version:
//! `post_job`, `assign_worker`, `complete_job`, `cancel_job`, `dispute_job`,
//! `get_job`, `list_jobs`, `poster_jobs`, `initialize`, `grant_role`,
//! `revoke_role`, `has_role`, `pause`, `unpause`, `is_paused`, `upgrade`.

#![no_std]
// soroban-sdk 26 deprecates `Events::publish` in favour of the `#[contractevent]`
// macro, and `Env::register_contract` in favour of `Env::register`. Migrating the
// event API changes the on-chain event ABI, so both are deliberately deferred to a
// dedicated upgrade rather than mixed into unrelated changes.
#![allow(deprecated)]

use soroban_sdk::{contract, contractimpl, symbol_short, Address, BytesN, Env, Symbol, Vec};

mod logic;
mod storage;

#[cfg(test)]
mod test;

use logic::{
    do_assign_worker, do_cancel_job, do_complete_job, do_dispute_job, do_initialize, do_post_job,
    require_role, role_to_id, ROLE_ADMIN, ROLE_PAUSER, ROLE_UPGRADER,
};
use storage::{
    is_paused, load_admin, load_job, load_job_list, load_poster_jobs, load_role_members,
    save_role_members, set_paused, Job,
};

pub const VERSION: u32 = 1;

#[contract]
pub struct JobRegistryContract;

#[contractimpl]
impl JobRegistryContract {
    // -------------------------------------------------------------------------
    // Initialise
    // -------------------------------------------------------------------------

    /// Initialise the contract with an admin address.
    ///
    /// # Panics
    /// - `"Already initialized"` if called more than once.
    pub fn initialize(env: Env, admin: Address) {
        do_initialize(&env, &admin);
    }

    // -------------------------------------------------------------------------
    // Role management
    // -------------------------------------------------------------------------

    /// Grant a role to an address. Caller must hold `ROLE_ADMIN`.
    pub fn grant_role(env: Env, caller: Address, role: Symbol, account: Address) {
        require_role(&env, &Symbol::new(&env, ROLE_ADMIN), &caller);
        let id = role_to_id(&env, &role);
        let mut members = load_role_members(&env, id);
        if !members.iter().any(|m| m == account) {
            members.push_back(account.clone());
        }
        save_role_members(&env, id, &members);
        env.events()
            .publish((symbol_short!("RlGrnt"), role), account);
    }

    /// Revoke a role from an address. Caller must hold `ROLE_ADMIN`.
    pub fn revoke_role(env: Env, caller: Address, role: Symbol, account: Address) {
        require_role(&env, &Symbol::new(&env, ROLE_ADMIN), &caller);
        let id = role_to_id(&env, &role);
        let members = load_role_members(&env, id);
        let mut updated: Vec<Address> = Vec::new(&env);
        for m in members.iter() {
            if m != account {
                updated.push_back(m);
            }
        }
        save_role_members(&env, id, &updated);
        env.events()
            .publish((symbol_short!("RlRevk"), role), account);
    }

    /// Return `true` if `account` holds `role`.
    pub fn has_role(env: Env, role: Symbol, account: Address) -> bool {
        let id = role_to_id(&env, &role);
        load_role_members(&env, id).iter().any(|m| m == account)
    }

    // -------------------------------------------------------------------------
    // Pause / Unpause
    // -------------------------------------------------------------------------

    /// Pause the contract. Caller must hold `ROLE_PAUSER`.
    pub fn pause(env: Env, caller: Address) {
        require_role(&env, &Symbol::new(&env, ROLE_PAUSER), &caller);
        set_paused(&env, true);
        env.events().publish((symbol_short!("Paused"), caller), ());
    }

    /// Unpause the contract. Caller must hold `ROLE_PAUSER`.
    pub fn unpause(env: Env, caller: Address) {
        require_role(&env, &Symbol::new(&env, ROLE_PAUSER), &caller);
        set_paused(&env, false);
        env.events()
            .publish((symbol_short!("Unpaused"), caller), ());
    }

    /// Return `true` if the contract is paused.
    pub fn is_paused(env: Env) -> bool {
        is_paused(&env)
    }

    /// Return the admin address.
    ///
    /// # Panics
    /// - `"Not initialized"` if called before `initialize`.
    pub fn get_admin(env: Env) -> Address {
        load_admin(&env).expect("Not initialized")
    }

    // -------------------------------------------------------------------------
    // Job lifecycle
    // -------------------------------------------------------------------------

    /// Post a new job listing.
    ///
    /// # Parameters
    /// - `poster`: Caller / job owner; `require_auth()` enforced.
    /// - `id`: Unique job identifier (caller-supplied).
    /// - `category`: Trade category symbol.
    /// - `description_hash`: SHA-256 of the off-chain job description.
    /// - `budget`: Maximum budget in token units (0 = unspecified).
    /// - `token`: Token contract address for budget (any valid Address).
    pub fn post_job(
        env: Env,
        poster: Address,
        id: Symbol,
        category: Symbol,
        description_hash: BytesN<32>,
        budget: i128,
        token: Address,
    ) -> Job {
        do_post_job(&env, &poster, id, category, description_hash, budget, token)
    }

    /// Assign a worker to an open job. Only the job poster may call this.
    pub fn assign_worker(env: Env, caller: Address, job_id: Symbol, worker: Address) {
        do_assign_worker(&env, &caller, job_id, worker);
    }

    /// Mark an assigned job as completed. Only the assigned worker may call this.
    pub fn complete_job(env: Env, caller: Address, job_id: Symbol) {
        do_complete_job(&env, &caller, job_id);
    }

    /// Cancel a job. Only the poster may call this.
    pub fn cancel_job(env: Env, caller: Address, job_id: Symbol) {
        do_cancel_job(&env, &caller, job_id);
    }

    /// File a dispute on an assigned job. Either party may call this.
    pub fn dispute_job(env: Env, caller: Address, job_id: Symbol) {
        do_dispute_job(&env, &caller, job_id);
    }

    // -------------------------------------------------------------------------
    // Queries
    // -------------------------------------------------------------------------

    /// Get a single job by id. Returns the `Job` struct.
    ///
    /// # Panics
    /// - `"Job not found"` if the id does not exist.
    pub fn get_job(env: Env, id: Symbol) -> Job {
        load_job(&env, &id).expect("Job not found")
    }

    /// Return all job ids in registration order.
    pub fn list_jobs(env: Env) -> Vec<Symbol> {
        load_job_list(&env)
    }

    /// Return all job ids posted by a specific address.
    pub fn poster_jobs(env: Env, poster: Address) -> Vec<Symbol> {
        load_poster_jobs(&env, &poster)
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
        require_role(&env, &Symbol::new(&env, ROLE_UPGRADER), &caller);
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}

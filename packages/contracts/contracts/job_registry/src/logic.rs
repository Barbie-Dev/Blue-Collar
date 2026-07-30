//! # Job-Registry — Business Logic
//!
//! All validation, state-transition rules, and RBAC helpers live here.
//! The `lib.rs` entry-point delegates to these functions after setting up
//! the `Env` context. No direct storage access from `lib.rs` — always via
//! `storage::*` or the helpers in this module.

use soroban_sdk::{symbol_short, Address, BytesN, Env, Symbol, Vec};

use crate::storage::{
    self, add_poster_job, load_job, load_job_list, load_role_members, save_job, save_job_list,
    save_role_members, Job, JobStatus,
};

// =============================================================================
// Roles
// =============================================================================

pub const ROLE_ADMIN: &str = "admin";
pub const ROLE_POSTER: &str = "poster";
pub const ROLE_UPGRADER: &str = "upgrader";
pub const ROLE_PAUSER: &str = "pauser";

pub const ROLE_ADMIN_ID: u64 = 0;
pub const ROLE_POSTER_ID: u64 = 1;
pub const ROLE_UPGRADER_ID: u64 = 2;
pub const ROLE_PAUSER_ID: u64 = 3;

/// Map a role `Symbol` to its compact storage id.
pub fn role_to_id(env: &Env, role: &Symbol) -> u64 {
    if *role == Symbol::new(env, ROLE_ADMIN) {
        ROLE_ADMIN_ID
    } else if *role == Symbol::new(env, ROLE_POSTER) {
        ROLE_POSTER_ID
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

/// Assert that `caller` holds `role` and has signed the transaction.
///
/// # Panics
/// - `"Missing role"` if `caller` is not in the role member list.
pub fn require_role(env: &Env, role: &Symbol, caller: &Address) {
    caller.require_auth();
    let id = role_to_id(env, role);
    let members = load_role_members(env, id);
    assert!(members.iter().any(|m| m == *caller), "Missing role");
}

/// Assert that the contract is not paused.
///
/// # Panics
/// - `"Contract is paused"` if paused.
pub fn require_not_paused(env: &Env) {
    assert!(!storage::is_paused(env), "Contract is paused");
}

// =============================================================================
// Initialisation logic
// =============================================================================

/// Bootstrap the contract: write admin, initial roles, schema version.
pub fn do_initialize(env: &Env, admin: &Address) {
    assert!(!storage::is_initialized(env), "Already initialized");

    storage::set_initialized(env);
    storage::save_admin(env, admin);
    env.storage()
        .persistent()
        .set(&storage::DataKey::SchemaVersion, &1u32);

    // Grant ROLE_ADMIN to the initial admin.
    let mut members: Vec<Address> = Vec::new(env);
    members.push_back(admin.clone());
    save_role_members(env, ROLE_ADMIN_ID, &members);

    env.events()
        .publish((symbol_short!("Init"), admin.clone()), 1u32);
}

// =============================================================================
// Job lifecycle logic
// =============================================================================

/// Post a new job listing.
///
/// # Panics
/// - `"Contract is paused"` if paused.
/// - `"Job already exists"` if `id` is already registered.
/// - `"budget must be non-negative"` if budget < 0.
pub fn do_post_job(
    env: &Env,
    poster: &Address,
    id: Symbol,
    category: Symbol,
    description_hash: BytesN<32>,
    budget: i128,
    token: Address,
) -> Job {
    // --- Checks ---
    require_not_paused(env);
    poster.require_auth();
    assert!(load_job(env, &id).is_none(), "Job already exists");
    assert!(budget >= 0, "budget must be non-negative");

    // --- Effects ---
    let job = Job {
        id: id.clone(),
        poster: poster.clone(),
        category,
        description_hash,
        budget,
        token,
        status: JobStatus::Open,
        worker: None,
        created_at: env.ledger().sequence(),
        updated_at: env.ledger().sequence(),
    };
    save_job(env, &job);

    let mut list = load_job_list(env);
    list.push_back(id.clone());
    save_job_list(env, &list);

    add_poster_job(env, poster, &id);

    // --- Interactions ---
    env.events()
        .publish((symbol_short!("JobPost"), id), (poster.clone(), budget));

    job
}

/// Assign a worker to an open job. Only the job poster may call this.
///
/// # Panics
/// - `"Job not found"` if `id` does not exist.
/// - `"Not job poster"` if caller is not the job poster.
/// - `"Job not open"` if job is not in `Open` status.
pub fn do_assign_worker(env: &Env, caller: &Address, job_id: Symbol, worker: Address) {
    // --- Checks ---
    require_not_paused(env);
    caller.require_auth();

    let mut job = load_job(env, &job_id).expect("Job not found");
    assert!(job.poster == *caller, "Not job poster");
    assert!(job.status == JobStatus::Open, "Job not open");

    // --- Effects ---
    job.worker = Some(worker.clone());
    job.status = JobStatus::Assigned;
    job.updated_at = env.ledger().sequence();
    save_job(env, &job);

    // --- Interactions ---
    env.events()
        .publish((symbol_short!("Assigned"), job_id), (caller.clone(), worker));
}

/// Mark a job as completed. Only the assigned worker may call this.
///
/// # Panics
/// - `"Job not found"` — job id does not exist.
/// - `"Not assigned worker"` — caller is not the assigned worker.
/// - `"Job not assigned"` — job is not in `Assigned` status.
pub fn do_complete_job(env: &Env, caller: &Address, job_id: Symbol) {
    // --- Checks ---
    require_not_paused(env);
    caller.require_auth();

    let mut job = load_job(env, &job_id).expect("Job not found");
    assert!(
        job.worker.as_ref() == Some(caller),
        "Not assigned worker"
    );
    assert!(job.status == JobStatus::Assigned, "Job not assigned");

    // --- Effects ---
    job.status = JobStatus::Completed;
    job.updated_at = env.ledger().sequence();
    save_job(env, &job);

    // --- Interactions ---
    env.events()
        .publish((symbol_short!("Completed"), job_id), caller.clone());
}

/// Cancel an open or assigned job. Only the poster may call this.
///
/// # Panics
/// - `"Job not found"` if id does not exist.
/// - `"Not job poster"` if caller is not the poster.
/// - `"Job already settled"` if status is Completed or Cancelled.
pub fn do_cancel_job(env: &Env, caller: &Address, job_id: Symbol) {
    // --- Checks ---
    require_not_paused(env);
    caller.require_auth();

    let mut job = load_job(env, &job_id).expect("Job not found");
    assert!(job.poster == *caller, "Not job poster");
    assert!(
        job.status != JobStatus::Completed && job.status != JobStatus::Cancelled,
        "Job already settled"
    );

    // --- Effects ---
    job.status = JobStatus::Cancelled;
    job.updated_at = env.ledger().sequence();
    save_job(env, &job);

    // --- Interactions ---
    env.events()
        .publish((symbol_short!("Cancelled"), job_id), caller.clone());
}

/// File a dispute on an assigned job. Either party (poster or worker) may call.
///
/// # Panics
/// - `"Job not found"` — job id does not exist.
/// - `"Not a party"` — caller is neither poster nor assigned worker.
/// - `"Job not assigned"` — only assigned jobs can be disputed.
pub fn do_dispute_job(env: &Env, caller: &Address, job_id: Symbol) {
    // --- Checks ---
    require_not_paused(env);
    caller.require_auth();

    let mut job = load_job(env, &job_id).expect("Job not found");
    let is_poster = job.poster == *caller;
    let is_worker = job.worker.as_ref() == Some(caller);
    assert!(is_poster || is_worker, "Not a party");
    assert!(job.status == JobStatus::Assigned, "Job not assigned");

    // --- Effects ---
    job.status = JobStatus::Disputed;
    job.updated_at = env.ledger().sequence();
    save_job(env, &job);

    // --- Interactions ---
    env.events()
        .publish((symbol_short!("Disputed"), job_id), caller.clone());
}

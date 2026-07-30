//! Regression tests for the reputation contract security audit (issue #1017).
//!
//! Covered findings:
//! 1. `slash_reputation` was unguarded — now requires `ROLE_REP_MGR`.
//! 2. `reset_reputation` was open to anyone — now requires `ROLE_ADMIN`.
//! 3. `submit_review` emitted event before writing state — CEI order fixed.
//! 4. `award_badge` emitted event before writing badge list — CEI order fixed.

#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    Address, BytesN, Env, Symbol,
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

fn zero_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let rep_mgr = Address::generate(&env);
    let worker = Address::generate(&env);

    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);

    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);

    (env, admin, rep_mgr, worker)
}

fn deploy_client(env: &Env) -> (Address, ReputationContractClient) {
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(env, &contract_id);
    (contract_id, client)
}

fn set_ledger(env: &Env, seq: u32) {
    env.ledger().set(LedgerInfo {
        timestamp: seq as u64 * 5,
        protocol_version: 22,
        sequence_number: seq,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 1_000_000,
    });
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

#[test]
fn test_initialize_success() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (_, client) = deploy_client(&env);

    client.initialize(&admin);
    assert_eq!(client.get_admin(), admin);
    assert!(!client.is_paused());
}

#[test]
#[should_panic(expected = "Already initialized")]
fn test_initialize_twice_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let (_, client) = deploy_client(&env);
    client.initialize(&admin);
    client.initialize(&admin); // must panic
}

// ---------------------------------------------------------------------------
// submit_review — CEI regression (#1017 finding 1)
// ---------------------------------------------------------------------------

#[test]
fn test_submit_review_updates_score() {
    let (env, _admin, rep_mgr, worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);

    let worker_id = Symbol::new(&env, "worker1");
    client.submit_review(&rep_mgr, &worker_id, &8_000, &zero_hash(&env));
    assert_eq!(client.get_score(&worker_id), 8_000);
}

#[test]
fn test_submit_review_averages_multiple() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);

    let worker_id = Symbol::new(&env, "workerA");
    client.submit_review(&rep_mgr, &worker_id, &6_000, &zero_hash(&env));
    client.submit_review(&rep_mgr, &worker_id, &10_000, &zero_hash(&env));
    // avg = (6000 + 10000) / 2 = 8000
    assert_eq!(client.get_score(&worker_id), 8_000);
}

#[test]
#[should_panic(expected = "Missing role")]
fn test_submit_review_unauthorized() {
    let (env, _admin, _rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let attacker = Address::generate(&env);
    let worker_id = Symbol::new(&env, "worker1");
    // attacker does NOT hold ROLE_REP_MGR — must panic
    client.submit_review(&attacker, &worker_id, &9_000, &zero_hash(&env));
}

#[test]
#[should_panic(expected = "rating_bps out of range")]
fn test_submit_review_rating_overflow() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);

    let worker_id = Symbol::new(&env, "worker1");
    client.submit_review(&rep_mgr, &worker_id, &10_001, &zero_hash(&env)); // > MAX_SCORE
}

// ---------------------------------------------------------------------------
// slash_reputation — access control regression (#1017 finding 2)
// ---------------------------------------------------------------------------

#[test]
fn test_slash_reputation_by_rep_mgr() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);

    let worker_id = Symbol::new(&env, "worker1");
    // First give the worker some reputation
    client.submit_review(&rep_mgr, &worker_id, &8_000, &zero_hash(&env));
    assert_eq!(client.get_score(&worker_id), 8_000);

    client.slash_reputation(&rep_mgr, &worker_id, &2_000);
    assert_eq!(client.get_score(&worker_id), 6_000);
}

#[test]
fn test_slash_reputation_clamps_at_zero() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);

    let worker_id = Symbol::new(&env, "worker1");
    client.submit_review(&rep_mgr, &worker_id, &1_000, &zero_hash(&env));
    // Slash more than current score — must clamp at 0, not underflow
    client.slash_reputation(&rep_mgr, &worker_id, &5_000);
    assert_eq!(client.get_score(&worker_id), 0);
}

#[test]
#[should_panic(expected = "Missing role")]
fn test_slash_reputation_unauthorized() {
    let (env, _admin, _rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let attacker = Address::generate(&env);
    let worker_id = Symbol::new(&env, "worker1");
    // REGRESSION: this call must fail — previously it was unguarded
    client.slash_reputation(&attacker, &worker_id, &5_000);
}

#[test]
#[should_panic(expected = "slash_bps out of range")]
fn test_slash_reputation_overflow_input() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);

    let worker_id = Symbol::new(&env, "worker1");
    client.slash_reputation(&rep_mgr, &worker_id, &10_001);
}

// ---------------------------------------------------------------------------
// reset_reputation — access control regression (#1017 finding 3)
// ---------------------------------------------------------------------------

#[test]
fn test_reset_reputation_by_admin() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);

    let worker_id = Symbol::new(&env, "worker1");
    client.submit_review(&rep_mgr, &worker_id, &9_000, &zero_hash(&env));
    assert_eq!(client.get_score(&worker_id), 9_000);

    client.reset_reputation(&admin, &worker_id);
    assert_eq!(client.get_score(&worker_id), 0);
    let record = client.get_record(&worker_id);
    assert_eq!(record.review_count, 0);
    assert_eq!(record.rating_sum, 0);
}

#[test]
#[should_panic(expected = "Missing role")]
fn test_reset_reputation_unauthorized() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);

    let attacker = Address::generate(&env);
    let worker_id = Symbol::new(&env, "worker1");
    client.submit_review(&rep_mgr, &worker_id, &9_000, &zero_hash(&env));
    // REGRESSION: rep_mgr should NOT be able to reset — only admin
    client.reset_reputation(&attacker, &worker_id);
}

#[test]
#[should_panic(expected = "Missing role")]
fn test_reset_reputation_rep_mgr_blocked() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);

    let worker_id = Symbol::new(&env, "worker1");
    client.submit_review(&rep_mgr, &worker_id, &9_000, &zero_hash(&env));
    // rep_mgr does NOT hold ROLE_ADMIN — must be blocked
    client.reset_reputation(&rep_mgr, &worker_id);
}

// ---------------------------------------------------------------------------
// award_badge — CEI regression (#1017 finding 4)
// ---------------------------------------------------------------------------

#[test]
fn test_award_badge_success() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);

    let worker_id = Symbol::new(&env, "worker1");
    let badge = Symbol::new(&env, "top_rated");
    client.award_badge(&rep_mgr, &worker_id, &badge);
    assert!(client.has_badge(&worker_id, &badge));
}

#[test]
#[should_panic(expected = "Badge already awarded")]
fn test_award_badge_duplicate_panics() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);

    let worker_id = Symbol::new(&env, "worker1");
    let badge = Symbol::new(&env, "top_rated");
    client.award_badge(&rep_mgr, &worker_id, &badge);
    client.award_badge(&rep_mgr, &worker_id, &badge); // duplicate — must panic
}

#[test]
#[should_panic(expected = "Missing role")]
fn test_award_badge_unauthorized() {
    let (env, _admin, _rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let attacker = Address::generate(&env);
    let worker_id = Symbol::new(&env, "worker1");
    client.award_badge(&attacker, &worker_id, &Symbol::new(&env, "badge"));
}

// ---------------------------------------------------------------------------
// revoke_badge
// ---------------------------------------------------------------------------

#[test]
fn test_revoke_badge_success() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);

    let worker_id = Symbol::new(&env, "worker1");
    let badge = Symbol::new(&env, "top_rated");
    client.award_badge(&rep_mgr, &worker_id, &badge);
    assert!(client.has_badge(&worker_id, &badge));

    client.revoke_badge(&rep_mgr, &worker_id, &badge);
    assert!(!client.has_badge(&worker_id, &badge));
}

// ---------------------------------------------------------------------------
// pause / unpause
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_submit_review_while_paused() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_PAUSER), &admin);

    client.pause(&admin);
    assert!(client.is_paused());

    let worker_id = Symbol::new(&env, "worker1");
    client.submit_review(&rep_mgr, &worker_id, &8_000, &zero_hash(&env));
}

#[test]
fn test_unpause_resumes_operations() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_PAUSER), &admin);

    client.pause(&admin);
    client.unpause(&admin);
    assert!(!client.is_paused());

    let worker_id = Symbol::new(&env, "worker1");
    client.submit_review(&rep_mgr, &worker_id, &5_000, &zero_hash(&env));
    assert_eq!(client.get_score(&worker_id), 5_000);
}

// ---------------------------------------------------------------------------
// Role management
// ---------------------------------------------------------------------------

#[test]
fn test_grant_and_has_role() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let new_mgr = Address::generate(&env);
    assert!(!client.has_role(&Symbol::new(&env, ROLE_REP_MGR), &new_mgr));
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &new_mgr);
    assert!(client.has_role(&Symbol::new(&env, ROLE_REP_MGR), &new_mgr));
}

#[test]
fn test_revoke_role() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);
    assert!(client.has_role(&Symbol::new(&env, ROLE_REP_MGR), &rep_mgr));

    client.revoke_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);
    assert!(!client.has_role(&Symbol::new(&env, ROLE_REP_MGR), &rep_mgr));
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

#[test]
fn test_get_reviews_returns_history() {
    let (env, _admin, rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    client.grant_role(&admin, &Symbol::new(&env, ROLE_REP_MGR), &rep_mgr);

    let worker_id = Symbol::new(&env, "worker1");
    client.submit_review(&rep_mgr, &worker_id, &7_000, &zero_hash(&env));
    client.submit_review(&rep_mgr, &worker_id, &9_000, &zero_hash(&env));

    let reviews = client.get_reviews(&worker_id);
    assert_eq!(reviews.len(), 2);
    assert_eq!(reviews.get(0).unwrap().rating_bps, 7_000);
    assert_eq!(reviews.get(1).unwrap().rating_bps, 9_000);
}

#[test]
fn test_get_score_returns_zero_for_unknown_worker() {
    let (env, _admin, _rep_mgr, _worker) = setup();
    let contract_id = env.register_contract(None, ReputationContract);
    let client = ReputationContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    assert_eq!(client.get_score(&Symbol::new(&env, "unknown")), 0);
}

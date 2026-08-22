//! Tests for the escrow contract (issue #1020).
//! Verifies that the public interface is stable after the modular refactor.

#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Symbol,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn setup_env() -> (Env, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = token_id.address();
    StellarAssetClient::new(&env, &token_addr).mint(&depositor, &100_000);

    let contract_id = env.register_contract(None, EscrowContract);
    (env, admin, depositor, beneficiary, token_addr, contract_id)
}

fn deploy_and_init<'a>(
    env: &'a Env,
    admin: &'a Address,
    contract_id: &'a Address,
) -> EscrowContractClient<'a> {
    let client = EscrowContractClient::new(env, contract_id);
    client.initialize(admin);
    client.grant_role(admin, &Symbol::new(env, logic::ROLE_PAUSER), admin);
    client.grant_role(admin, &Symbol::new(env, logic::ROLE_ARBITRATOR), admin);
    client
}

fn set_time(env: &Env, ts: u64) {
    env.ledger().set(LedgerInfo {
        timestamp: ts,
        protocol_version: 26,
        sequence_number: 100,
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
fn test_initialize_sets_admin() {
    let (env, admin, _, _, _, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    assert_eq!(client.get_admin(), admin);
    assert!(!client.is_paused());
}

#[test]
#[should_panic(expected = "Already initialized")]
fn test_initialize_twice_panics() {
    let (env, admin, _, _, _, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    client.initialize(&admin);
}

// ---------------------------------------------------------------------------
// create_escrow
// ---------------------------------------------------------------------------

#[test]
fn test_create_escrow_success() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &10_000, &5_000);

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&contract_id), 10_000);

    let record = client.get_escrow(&id);
    assert_eq!(record.amount, 10_000);
    assert_eq!(record.state, storage::EscrowState::Active);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_create_escrow_zero_amount_panics() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);
    client.create_escrow(
        &depositor,
        &beneficiary,
        &token,
        &Symbol::new(&env, "e1"),
        &0,
        &5_000,
    );
}

#[test]
#[should_panic(expected = "expiry must be in future")]
fn test_create_escrow_past_expiry_panics() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 5_000);
    client.create_escrow(
        &depositor,
        &beneficiary,
        &token,
        &Symbol::new(&env, "e1"),
        &1_000,
        &1_000, // expiry in the past
    );
}

#[test]
#[should_panic(expected = "Escrow already exists")]
fn test_create_escrow_duplicate_panics() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);
    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &1_000, &9_000);
    client.create_escrow(&depositor, &beneficiary, &token, &id, &1_000, &9_000);
}

// ---------------------------------------------------------------------------
// release_escrow
// ---------------------------------------------------------------------------

#[test]
fn test_release_escrow_by_depositor() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &5_000, &9_000);
    client.release_escrow(&depositor, &id);

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&beneficiary), 5_000);
    assert_eq!(client.get_escrow(&id).state, storage::EscrowState::Released);
}

#[test]
fn test_release_escrow_by_admin() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &5_000, &9_000);
    client.release_escrow(&admin, &id);

    assert_eq!(client.get_escrow(&id).state, storage::EscrowState::Released);
}

#[test]
#[should_panic(expected = "Not authorized")]
fn test_release_escrow_by_stranger_panics() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let stranger = Address::generate(&env);
    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &5_000, &9_000);
    client.release_escrow(&stranger, &id);
}

#[test]
#[should_panic(expected = "Escrow not active")]
fn test_release_escrow_already_released_panics() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &5_000, &9_000);
    client.release_escrow(&depositor, &id);
    client.release_escrow(&depositor, &id);
}

// ---------------------------------------------------------------------------
// cancel_escrow
// ---------------------------------------------------------------------------

#[test]
fn test_cancel_escrow_by_admin_before_expiry() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &3_000, &9_000);

    let token_client = TokenClient::new(&env, &token);
    let before = token_client.balance(&depositor);
    client.cancel_escrow(&admin, &id);
    assert_eq!(token_client.balance(&depositor), before + 3_000);
    assert_eq!(
        client.get_escrow(&id).state,
        storage::EscrowState::Cancelled
    );
}

#[test]
fn test_cancel_escrow_by_depositor_after_expiry() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &3_000, &2_000);

    // Advance past expiry
    set_time(&env, 3_000);
    client.cancel_escrow(&depositor, &id);
    assert_eq!(
        client.get_escrow(&id).state,
        storage::EscrowState::Cancelled
    );
}

#[test]
#[should_panic(expected = "Not authorized")]
fn test_cancel_escrow_by_depositor_before_expiry_panics() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &3_000, &9_000);
    client.cancel_escrow(&depositor, &id); // before expiry — must fail
}

// ---------------------------------------------------------------------------
// dispute_escrow
// ---------------------------------------------------------------------------

#[test]
fn test_dispute_by_depositor() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &5_000, &9_000);
    client.dispute_escrow(&depositor, &id);
    assert_eq!(client.get_escrow(&id).state, storage::EscrowState::Disputed);
}

#[test]
fn test_dispute_by_beneficiary() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &5_000, &9_000);
    client.dispute_escrow(&beneficiary, &id);
    assert_eq!(client.get_escrow(&id).state, storage::EscrowState::Disputed);
}

#[test]
#[should_panic(expected = "Not a party")]
fn test_dispute_by_stranger_panics() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let stranger = Address::generate(&env);
    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &5_000, &9_000);
    client.dispute_escrow(&stranger, &id);
}

// ---------------------------------------------------------------------------
// resolve_dispute
// ---------------------------------------------------------------------------

#[test]
fn test_resolve_dispute_release_to_beneficiary() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &6_000, &9_000);
    client.dispute_escrow(&depositor, &id);
    client.resolve_dispute(&admin, &id, &true);

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&beneficiary), 6_000);
    assert_eq!(client.get_escrow(&id).state, storage::EscrowState::Released);
}

#[test]
fn test_resolve_dispute_refund_to_depositor() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &6_000, &9_000);
    client.dispute_escrow(&depositor, &id);

    let token_client = TokenClient::new(&env, &token);
    let before = token_client.balance(&depositor);
    client.resolve_dispute(&admin, &id, &false);

    assert_eq!(token_client.balance(&depositor), before + 6_000);
    assert_eq!(
        client.get_escrow(&id).state,
        storage::EscrowState::Cancelled
    );
}

#[test]
#[should_panic(expected = "Missing role")]
fn test_resolve_dispute_unauthorized_panics() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let stranger = Address::generate(&env);
    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &5_000, &9_000);
    client.dispute_escrow(&depositor, &id);
    client.resolve_dispute(&stranger, &id, &true);
}

#[test]
#[should_panic(expected = "Escrow not disputed")]
fn test_resolve_non_disputed_panics() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &5_000, &9_000);
    // Not disputed yet — must fail
    client.resolve_dispute(&admin, &id, &true);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_resolve_dispute_while_paused_panics() {
    // Regression test: every other fund-moving entry point (create/release/
    // cancel/dispute) checks require_not_paused, but resolve_dispute did
    // not — an emergency pause could be bypassed by an arbitrator still
    // moving escrowed funds via dispute resolution.
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "esc1");
    client.create_escrow(&depositor, &beneficiary, &token, &id, &5_000, &9_000);
    client.dispute_escrow(&depositor, &id);

    client.pause(&admin);
    client.resolve_dispute(&admin, &id, &true);
}

// ---------------------------------------------------------------------------
// list_escrows
// ---------------------------------------------------------------------------

#[test]
fn test_list_escrows() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    client.create_escrow(
        &depositor,
        &beneficiary,
        &token,
        &Symbol::new(&env, "e1"),
        &1_000,
        &9_000,
    );
    client.create_escrow(
        &depositor,
        &beneficiary,
        &token,
        &Symbol::new(&env, "e2"),
        &2_000,
        &9_000,
    );

    assert_eq!(client.list_escrows().len(), 2);
}

// ---------------------------------------------------------------------------
// pause / unpause
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_create_while_paused_panics() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    client.pause(&admin);
    client.create_escrow(
        &depositor,
        &beneficiary,
        &token,
        &Symbol::new(&env, "e1"),
        &1_000,
        &9_000,
    );
}

#[test]
fn test_unpause_resumes_operations() {
    let (env, admin, depositor, beneficiary, token, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    set_time(&env, 1_000);

    client.pause(&admin);
    client.unpause(&admin);
    assert!(!client.is_paused());

    client.create_escrow(
        &depositor,
        &beneficiary,
        &token,
        &Symbol::new(&env, "e1"),
        &1_000,
        &9_000,
    );
    assert_eq!(client.list_escrows().len(), 1);
}

// ---------------------------------------------------------------------------
// extend_escrow_ttl (permissionless)
// ---------------------------------------------------------------------------

#[test]
fn test_extend_escrow_ttl_noop_when_missing() {
    let (env, admin, _, _, _, contract_id) = setup_env();
    let client = deploy_and_init(&env, &admin, &contract_id);
    // Should not panic — just a no-op
    client.extend_escrow_ttl(&Symbol::new(&env, "ghost"));
}

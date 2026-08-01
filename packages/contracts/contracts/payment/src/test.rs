//! Comprehensive unit tests for the payment contract (issue #1019).
//!
//! Coverage targets (90%+ lines):
//! - initialize: success, double-init, fee too high
//! - pay: success with fee, zero fee, zero amount, paused, unauthorized
//! - lock_payment: success, duplicate id, zero amount, expired, paused
//! - release_payment: by client, by admin, wrong caller, already released, not found
//! - refund_payment: by admin, by expired client, before expiry (not client/admin), already refunded
//! - update_fee: success, too high, unauthorized
//! - set_treasury: success, unauthorized
//! - pause/unpause: flow, unauthorized
//! - grant_role / revoke_role / has_role

#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Symbol,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn setup_env() -> (Env, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let client_addr = Address::generate(&env);
    let worker = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = token_id.address();
    StellarAssetClient::new(&env, &token_addr).mint(&client_addr, &100_000);

    (env, admin, fee_recipient, client_addr, worker, token_addr)
}

fn deploy(env: &Env) -> (Address, PaymentContractClient) {
    let id = env.register_contract(None, PaymentContract);
    let client = PaymentContractClient::new(env, &id);
    (id, client)
}

fn init(
    env: &Env,
    client: &PaymentContractClient,
    admin: &Address,
    fee_bps: u32,
    fee_recipient: &Address,
) {
    client.initialize(admin, &fee_bps, fee_recipient);
    // Grant fee_mgr and pauser roles to admin for convenience
    client.grant_role(admin, &Symbol::new(env, ROLE_FEE_MGR), admin);
    client.grant_role(admin, &Symbol::new(env, ROLE_PAUSER), admin);
}

fn set_time(env: &Env, ts: u64) {
    env.ledger().set(LedgerInfo {
        timestamp: ts,
        protocol_version: 22,
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
fn test_initialize_success() {
    let (env, admin, fee_recipient, _, _, _) = setup_env();
    let (_, client) = deploy(&env);
    init(&env, &client, &admin, 100, &fee_recipient);

    let config = client.get_config_view();
    assert_eq!(config.fee_bps, 100);
    assert_eq!(config.fee_recipient, fee_recipient);
    assert_eq!(client.get_admin(), admin);
}

#[test]
#[should_panic(expected = "Already initialized")]
fn test_initialize_twice_panics() {
    let (env, admin, fee_recipient, _, _, _) = setup_env();
    let (_, client) = deploy(&env);
    init(&env, &client, &admin, 100, &fee_recipient);
    client.initialize(&admin, &100, &fee_recipient);
}

#[test]
#[should_panic(expected = "fee_bps exceeds maximum (500)")]
fn test_initialize_fee_too_high() {
    let (env, admin, fee_recipient, _, _, _) = setup_env();
    let (_, client) = deploy(&env);
    client.initialize(&admin, &501, &fee_recipient);
}

// ---------------------------------------------------------------------------
// pay — direct payment
// ---------------------------------------------------------------------------

#[test]
fn test_pay_with_fee() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (contract_id, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 100, &fee_recipient); // 1% fee

    let token_client = TokenClient::new(&env, &token);
    let before_worker = token_client.balance(&worker);
    let before_fee = token_client.balance(&fee_recipient);

    pmt.pay(&client_addr, &worker, &token, &10_000);

    // Net = 9900, fee = 100
    assert_eq!(token_client.balance(&worker), before_worker + 9_900);
    assert_eq!(token_client.balance(&fee_recipient), before_fee + 100);
}

#[test]
fn test_pay_zero_fee() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);

    let token_client = TokenClient::new(&env, &token);
    let before = token_client.balance(&worker);

    pmt.pay(&client_addr, &worker, &token, &5_000);
    assert_eq!(token_client.balance(&worker), before + 5_000);
}

#[test]
#[should_panic(expected = "Amount must be positive")]
fn test_pay_zero_amount_panics() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 100, &fee_recipient);
    pmt.pay(&client_addr, &worker, &token, &0);
}

#[test]
#[should_panic(expected = "Amount must be positive")]
fn test_pay_negative_amount_panics() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 100, &fee_recipient);
    pmt.pay(&client_addr, &worker, &token, &-1);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_pay_while_paused_panics() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 100, &fee_recipient);
    pmt.pause(&admin);
    pmt.pay(&client_addr, &worker, &token, &1_000);
}

// ---------------------------------------------------------------------------
// lock_payment
// ---------------------------------------------------------------------------

#[test]
fn test_lock_payment_success() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (contract_id, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    set_time(&env, 1_000);

    let payment_id = Symbol::new(&env, "pay1");
    pmt.lock_payment(&client_addr, &worker, &token, &payment_id, &5_000, &2_000);

    // Funds should be held by the contract
    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&contract_id), 5_000);

    let record = pmt.get_payment(&payment_id);
    assert_eq!(record.amount, 5_000);
    assert_eq!(record.status, PaymentStatus::Locked);
}

#[test]
#[should_panic(expected = "Amount must be positive")]
fn test_lock_payment_zero_amount_panics() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    set_time(&env, 1_000);
    pmt.lock_payment(&client_addr, &worker, &token, &Symbol::new(&env, "p1"), &0, &2_000);
}

#[test]
#[should_panic(expected = "expiry must be in future")]
fn test_lock_payment_expired_expiry_panics() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    set_time(&env, 5_000);
    // expiry (1000) < now (5000)
    pmt.lock_payment(&client_addr, &worker, &token, &Symbol::new(&env, "p1"), &1_000, &1_000);
}

#[test]
#[should_panic(expected = "Already exists")]
fn test_lock_payment_duplicate_panics() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    set_time(&env, 1_000);
    let id = Symbol::new(&env, "p1");
    pmt.lock_payment(&client_addr, &worker, &token, &id, &1_000, &9_000);
    pmt.lock_payment(&client_addr, &worker, &token, &id, &1_000, &9_000);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_lock_payment_while_paused_panics() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    set_time(&env, 1_000);
    pmt.pause(&admin);
    pmt.lock_payment(&client_addr, &worker, &token, &Symbol::new(&env, "p1"), &1_000, &9_000);
}

// ---------------------------------------------------------------------------
// release_payment
// ---------------------------------------------------------------------------

#[test]
fn test_release_payment_by_client() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "p1");
    pmt.lock_payment(&client_addr, &worker, &token, &id, &4_000, &9_000);
    pmt.release_payment(&client_addr, &id);

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&worker), 4_000);

    let record = pmt.get_payment(&id);
    assert_eq!(record.status, PaymentStatus::Released);
}

#[test]
fn test_release_payment_by_admin() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "p1");
    pmt.lock_payment(&client_addr, &worker, &token, &id, &4_000, &9_000);
    pmt.release_payment(&admin, &id); // admin can release

    let record = pmt.get_payment(&id);
    assert_eq!(record.status, PaymentStatus::Released);
}

#[test]
#[should_panic(expected = "Not authorized")]
fn test_release_payment_by_stranger_panics() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    set_time(&env, 1_000);

    let stranger = Address::generate(&env);
    let id = Symbol::new(&env, "p1");
    pmt.lock_payment(&client_addr, &worker, &token, &id, &4_000, &9_000);
    pmt.release_payment(&stranger, &id);
}

#[test]
#[should_panic(expected = "Payment not locked")]
fn test_release_payment_already_released_panics() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "p1");
    pmt.lock_payment(&client_addr, &worker, &token, &id, &4_000, &9_000);
    pmt.release_payment(&client_addr, &id);
    pmt.release_payment(&client_addr, &id); // second call must fail
}

#[test]
#[should_panic(expected = "Payment not found")]
fn test_release_payment_not_found_panics() {
    let (env, admin, fee_recipient, client_addr, _, _) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    pmt.release_payment(&client_addr, &Symbol::new(&env, "ghost"));
}

// ---------------------------------------------------------------------------
// refund_payment
// ---------------------------------------------------------------------------

#[test]
fn test_refund_payment_by_admin_before_expiry() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "p1");
    pmt.lock_payment(&client_addr, &worker, &token, &id, &3_000, &9_000);

    let token_client = TokenClient::new(&env, &token);
    let before = token_client.balance(&client_addr);

    pmt.refund_payment(&admin, &id);

    assert_eq!(token_client.balance(&client_addr), before + 3_000);
    assert_eq!(pmt.get_payment(&id).status, PaymentStatus::Refunded);
}

#[test]
fn test_refund_payment_by_client_after_expiry() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "p1");
    pmt.lock_payment(&client_addr, &worker, &token, &id, &3_000, &2_000);

    // Advance time past expiry
    set_time(&env, 3_000);
    pmt.refund_payment(&client_addr, &id);

    assert_eq!(pmt.get_payment(&id).status, PaymentStatus::Refunded);
}

#[test]
#[should_panic(expected = "Not authorized")]
fn test_refund_payment_by_client_before_expiry_panics() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "p1");
    pmt.lock_payment(&client_addr, &worker, &token, &id, &3_000, &9_000);

    // Time is before expiry — client cannot refund yet
    pmt.refund_payment(&client_addr, &id);
}

#[test]
#[should_panic(expected = "Not authorized")]
fn test_refund_payment_by_stranger_panics() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    set_time(&env, 1_000);

    let stranger = Address::generate(&env);
    let id = Symbol::new(&env, "p1");
    pmt.lock_payment(&client_addr, &worker, &token, &id, &3_000, &9_000);
    pmt.refund_payment(&stranger, &id);
}

#[test]
#[should_panic(expected = "Payment not locked")]
fn test_refund_payment_already_refunded_panics() {
    let (env, admin, fee_recipient, client_addr, worker, token) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    set_time(&env, 1_000);

    let id = Symbol::new(&env, "p1");
    pmt.lock_payment(&client_addr, &worker, &token, &id, &3_000, &9_000);
    pmt.refund_payment(&admin, &id);
    pmt.refund_payment(&admin, &id); // second refund must fail
}

#[test]
#[should_panic(expected = "Payment not found")]
fn test_refund_payment_not_found_panics() {
    let (env, admin, fee_recipient, _, _, _) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    pmt.refund_payment(&admin, &Symbol::new(&env, "ghost"));
}

// ---------------------------------------------------------------------------
// update_fee
// ---------------------------------------------------------------------------

#[test]
fn test_update_fee_success() {
    let (env, admin, fee_recipient, _, _, _) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 100, &fee_recipient);

    pmt.update_fee(&admin, &200);
    assert_eq!(pmt.get_config_view().fee_bps, 200);
}

#[test]
#[should_panic(expected = "fee_bps exceeds maximum (500)")]
fn test_update_fee_too_high_panics() {
    let (env, admin, fee_recipient, _, _, _) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 100, &fee_recipient);
    pmt.update_fee(&admin, &501);
}

#[test]
#[should_panic(expected = "Missing role")]
fn test_update_fee_unauthorized_panics() {
    let (env, admin, fee_recipient, _, _, _) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 100, &fee_recipient);
    let attacker = Address::generate(&env);
    pmt.update_fee(&attacker, &50);
}

// ---------------------------------------------------------------------------
// set_treasury
// ---------------------------------------------------------------------------

#[test]
fn test_set_treasury_success() {
    let (env, admin, fee_recipient, _, _, _) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 100, &fee_recipient);

    let new_treasury = Address::generate(&env);
    pmt.set_treasury(&admin, &new_treasury);
    assert_eq!(pmt.get_config_view().fee_recipient, new_treasury);
}

#[test]
#[should_panic(expected = "Missing role")]
fn test_set_treasury_unauthorized_panics() {
    let (env, admin, fee_recipient, _, _, _) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 100, &fee_recipient);
    let attacker = Address::generate(&env);
    pmt.set_treasury(&attacker, &Address::generate(&env));
}

// ---------------------------------------------------------------------------
// pause / unpause
// ---------------------------------------------------------------------------

#[test]
fn test_pause_and_unpause() {
    let (env, admin, fee_recipient, _, _, _) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);

    assert!(!pmt.is_paused());
    pmt.pause(&admin);
    assert!(pmt.is_paused());
    pmt.unpause(&admin);
    assert!(!pmt.is_paused());
}

#[test]
#[should_panic(expected = "Missing role")]
fn test_pause_unauthorized_panics() {
    let (env, admin, fee_recipient, _, _, _) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    let attacker = Address::generate(&env);
    pmt.pause(&attacker);
}

// ---------------------------------------------------------------------------
// grant_role / revoke_role / has_role
// ---------------------------------------------------------------------------

#[test]
fn test_grant_and_revoke_role() {
    let (env, admin, fee_recipient, _, _, _) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);

    let new_mgr = Address::generate(&env);
    assert!(!pmt.has_role(&Symbol::new(&env, ROLE_FEE_MGR), &new_mgr));

    pmt.grant_role(&admin, &Symbol::new(&env, ROLE_FEE_MGR), &new_mgr);
    assert!(pmt.has_role(&Symbol::new(&env, ROLE_FEE_MGR), &new_mgr));

    pmt.revoke_role(&admin, &Symbol::new(&env, ROLE_FEE_MGR), &new_mgr);
    assert!(!pmt.has_role(&Symbol::new(&env, ROLE_FEE_MGR), &new_mgr));
}

#[test]
#[should_panic(expected = "Missing role")]
fn test_grant_role_unauthorized_panics() {
    let (env, admin, fee_recipient, _, _, _) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    let attacker = Address::generate(&env);
    pmt.grant_role(&attacker, &Symbol::new(&env, ROLE_FEE_MGR), &attacker);
}

// ---------------------------------------------------------------------------
// get_payment — not found
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Payment not found")]
fn test_get_payment_not_found_panics() {
    let (env, admin, fee_recipient, _, _, _) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    pmt.get_payment(&Symbol::new(&env, "missing"));
}

// ---------------------------------------------------------------------------
// extend_payment_ttl_pub (permissionless)
// ---------------------------------------------------------------------------

#[test]
fn test_extend_payment_ttl_pub_noop_when_not_found() {
    let (env, admin, fee_recipient, _, _, _) = setup_env();
    let (_, pmt) = deploy(&env);
    init(&env, &pmt, &admin, 0, &fee_recipient);
    // Should not panic — just a no-op when entry doesn't exist
    pmt.extend_payment_ttl_pub(&Symbol::new(&env, "ghost"));
}

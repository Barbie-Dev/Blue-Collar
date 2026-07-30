#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env, Symbol, Vec,
};

struct AuthFixture {
    env: Env,
    contract: Address,
    admin: Address,
    pauser: Address,
    fee_mgr: Address,
    upgrader: Address,
    stranger: Address,
    token: Address,
    recipient_a: Address,
    recipient_b: Address,
}

impl AuthFixture {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let pauser = Address::generate(&env);
        let fee_mgr = Address::generate(&env);
        let upgrader = Address::generate(&env);
        let stranger = Address::generate(&env);
        let recipient_a = Address::generate(&env);
        let recipient_b = Address::generate(&env);

        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let token = token_id.address();
        StellarAssetClient::new(&env, &token).mint(&admin, &1_000_000);

        let contract = env.register_contract(None, FeeDistributionContract);
        let client = FeeDistributionContractClient::new(&env, &contract);
        client.initialize(&admin);

        // Grant operational roles
        client.grant_role(&admin, &Symbol::new(&env, ROLE_PAUSER), &pauser);
        client.grant_role(&admin, &Symbol::new(&env, ROLE_FEE_MANAGER), &fee_mgr);
        client.grant_role(&admin, &Symbol::new(&env, ROLE_UPGRADER), &upgrader);

        // Set fee recipient for distribution tests
        let recipients = Vec::from_array(&env, [
            FeeRecipient { address: recipient_a.clone(), percentage_bps: 6_000 },
            FeeRecipient { address: recipient_b.clone(), percentage_bps: 4_000 },
        ]);
        client.set_fee_recipients(&fee_mgr, &recipients);

        AuthFixture {
            env, contract, admin, pauser, fee_mgr, upgrader, stranger,
            token, recipient_a, recipient_b,
        }
    }

    fn client(&self) -> FeeDistributionContractClient {
        FeeDistributionContractClient::new(&self.env, &self.contract)
    }

    fn collect_some_fees(&self) {
        let token_client = TokenClient::new(&self.env, &self.token);
        let admin_signer = self.admin.clone();
        token_client.approve(&admin_signer, &self.contract, &100_000, &200_000);
        self.client().collect_fees(&self.admin, &self.token, &100_000);
    }
}

// =============================================================================
// Auth-failure tests (role-gated functions)
// =============================================================================

mod auth_failures {
    use super::*;

    #[test]
    #[should_panic(expected = "Missing role")]
    fn grant_role_requires_admin() {
        let f = AuthFixture::new();
        let role = Symbol::new(&f.env, ROLE_PAUSER);
        f.client().grant_role(&f.stranger, &role, &Address::generate(&f.env));
    }

    #[test]
    #[should_panic(expected = "Missing role")]
    fn revoke_role_requires_admin() {
        let f = AuthFixture::new();
        let role = Symbol::new(&f.env, ROLE_PAUSER);
        f.client().revoke_role(&f.stranger, &role, &f.pauser);
    }

    #[test]
    #[should_panic(expected = "Missing role")]
    fn pause_requires_pauser() {
        let f = AuthFixture::new();
        f.client().pause(&f.stranger);
    }

    #[test]
    #[should_panic(expected = "Missing role")]
    fn unpause_requires_admin() {
        let f = AuthFixture::new();
        f.client().pause(&f.pauser);
        f.client().unpause(&f.stranger);
    }

    #[test]
    #[should_panic(expected = "Missing role")]
    fn set_fee_recipients_requires_fee_mgr() {
        let f = AuthFixture::new();
        let recipients = Vec::new(&f.env);
        f.client().set_fee_recipients(&f.stranger, &recipients);
    }

    #[test]
    #[should_panic(expected = "Missing role")]
    fn distribute_fees_requires_fee_mgr() {
        let f = AuthFixture::new();
        f.collect_some_fees();
        f.client().distribute_fees(&f.stranger, &f.token);
    }

    #[test]
    #[should_panic(expected = "Missing role")]
    fn withdraw_fees_requires_admin() {
        let f = AuthFixture::new();
        f.client().withdraw_fees(&f.stranger, &f.token, &100);
    }

    #[test]
    #[should_panic(expected = "Missing role")]
    fn upgrade_requires_upgrader() {
        let f = AuthFixture::new();
        let hash = BytesN::from_array(&f.env, &[1u8; 32]);
        f.client().upgrade(&f.stranger, &hash);
    }
}

// =============================================================================
// Paused-state tests
// =============================================================================

mod paused_state {
    use super::*;

    #[test]
    #[should_panic(expected = "Contract is paused")]
    fn grant_role_while_paused() {
        let f = AuthFixture::new();
        f.client().pause(&f.pauser);
        let role = Symbol::new(&f.env, ROLE_PAUSER);
        f.client().grant_role(&f.admin, &role, &Address::generate(&f.env));
    }

    #[test]
    #[should_panic(expected = "Contract is paused")]
    fn revoke_role_while_paused() {
        let f = AuthFixture::new();
        f.client().pause(&f.pauser);
        let role = Symbol::new(&f.env, ROLE_PAUSER);
        f.client().revoke_role(&f.admin, &role, &f.pauser);
    }

    #[test]
    #[should_panic(expected = "Contract is paused")]
    fn set_fee_recipients_while_paused() {
        let f = AuthFixture::new();
        f.client().pause(&f.pauser);
        let recipients = Vec::new(&f.env);
        f.client().set_fee_recipients(&f.fee_mgr, &recipients);
    }

    #[test]
    #[should_panic(expected = "Contract is paused")]
    fn distribute_fees_while_paused() {
        let f = AuthFixture::new();
        f.collect_some_fees();
        f.client().pause(&f.pauser);
        f.client().distribute_fees(&f.fee_mgr, &f.token);
    }

    #[test]
    #[should_panic(expected = "Contract is paused")]
    fn collect_fees_while_paused() {
        let f = AuthFixture::new();
        f.client().pause(&f.pauser);
        f.client().collect_fees(&f.admin, &f.token, &100);
    }
}

// =============================================================================
// Boundary tests
// =============================================================================

mod boundary {
    use super::*;

    #[test]
    #[should_panic(expected = "Amount must be positive")]
    fn collect_fees_zero_amount() {
        let f = AuthFixture::new();
        f.client().collect_fees(&f.admin, &f.token, &0);
    }

    #[test]
    #[should_panic(expected = "Amount must be positive")]
    fn withdraw_fees_zero_amount() {
        let f = AuthFixture::new();
        f.client().withdraw_fees(&f.admin, &f.token, &0);
    }

    #[test]
    #[should_panic(expected = "Percentages must sum to 100%")]
    fn set_recipients_total_under_100() {
        let f = AuthFixture::new();
        let recipients = Vec::from_array(&f.env, [
            FeeRecipient { address: f.recipient_a.clone(), percentage_bps: 3_000 },
            FeeRecipient { address: f.recipient_b.clone(), percentage_bps: 3_000 },
        ]);
        f.client().set_fee_recipients(&f.fee_mgr, &recipients);
    }

    #[test]
    #[should_panic(expected = "Percentages must sum to 100%")]
    fn set_recipients_total_over_100() {
        let f = AuthFixture::new();
        let recipients = Vec::from_array(&f.env, [
            FeeRecipient { address: f.recipient_a.clone(), percentage_bps: 6_000 },
            FeeRecipient { address: f.recipient_b.clone(), percentage_bps: 5_000 },
        ]);
        f.client().set_fee_recipients(&f.fee_mgr, &recipients);
    }

    #[test]
    #[should_panic(expected = "No fee recipients configured")]
    fn distribute_without_recipients() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let fee_mgr = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let token = token_id.address();

        let contract = env.register_contract(None, FeeDistributionContract);
        let client = FeeDistributionContractClient::new(&env, &contract);
        client.initialize(&admin);
        client.grant_role(&admin, &Symbol::new(&env, ROLE_FEE_MANAGER), &fee_mgr);

        // No recipients set, try to distribute
        client.distribute_fees(&fee_mgr, &token);
    }

    #[test]
    #[should_panic(expected = "No fees to distribute")]
    fn distribute_without_collected_fees() {
        let f = AuthFixture::new();
        f.client().distribute_fees(&f.fee_mgr, &f.token);
    }

    #[test]
    fn set_recipients_single_recipient_100_percent() {
        let f = AuthFixture::new();
        let recipients = Vec::from_array(&f.env, [
            FeeRecipient { address: f.recipient_a.clone(), percentage_bps: 10_000 },
        ]);
        f.client().set_fee_recipients(&f.fee_mgr, &recipients);
        let stored = f.client().get_fee_recipients();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored.get(0).unwrap().percentage_bps, 10_000);
    }

    #[test]
    #[should_panic(expected = "Account does not hold role")]
    fn revoke_nonexistent_role() {
        let f = AuthFixture::new();
        let role = Symbol::new(&f.env, ROLE_PAUSER);
        f.client().revoke_role(&f.admin, &role, &f.stranger);
    }
}

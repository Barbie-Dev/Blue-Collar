#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env, Symbol,
};

struct AuthFixture {
    env: Env,
    contract: Address,
    admin: Address,
    pauser: Address,
    claims_mgr: Address,
    stranger: Address,
    token: Address,
    member: Address,
}

impl AuthFixture {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let pauser = Address::generate(&env);
        let claims_mgr = Address::generate(&env);
        let upgrader = Address::generate(&env);
        let stranger = Address::generate(&env);
        let member = Address::generate(&env);

        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let token = token_id.address();
        StellarAssetClient::new(&env, &token).mint(&member, &1_000_000);

        let contract = env.register_contract(None, InsurancePoolContract);
        let client = InsurancePoolContractClient::new(&env, &contract);
        client.initialize(&admin, &token, &500);

        // Grant operational roles
        client.grant_role(&admin, &Symbol::new(&env, ROLE_PAUSER), &pauser);
        client.grant_role(&admin, &Symbol::new(&env, ROLE_CLAIMS_MGR), &claims_mgr);
        client.grant_role(&admin, &Symbol::new(&env, ROLE_UPGRADER), &upgrader);

        AuthFixture {
            env,
            contract,
            admin,
            pauser,
            claims_mgr,
            stranger,
            token,
            member,
        }
    }

    fn client(&self) -> InsurancePoolContractClient<'_> {
        InsurancePoolContractClient::new(&self.env, &self.contract)
    }

    fn contribute(&self) {
        self.contribute_from(&self.member, 100_000);
    }

    /// Fund `who`, approve the pool as spender, and contribute `amount`.
    fn contribute_from(&self, who: &Address, amount: i128) {
        StellarAssetClient::new(&self.env, &self.token).mint(who, &amount);
        TokenClient::new(&self.env, &self.token).approve(who, &self.contract, &amount, &200_000);
        self.client().contribute(who, &self.token, &amount);
    }

    fn file_claim(&self, claim_id: &str) {
        self.client()
            .file_claim(&self.member, &Symbol::new(&self.env, claim_id), &10_000);
    }

    fn approve_claim(&self, claim_id: &str) {
        self.client()
            .approve_claim(&self.claims_mgr, &Symbol::new(&self.env, claim_id));
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
        f.client()
            .grant_role(&f.stranger, &role, &Address::generate(&f.env));
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
    fn approve_claim_requires_claims_mgr() {
        let f = AuthFixture::new();
        f.contribute();
        f.file_claim("c1");
        f.client()
            .approve_claim(&f.stranger, &Symbol::new(&f.env, "c1"));
    }

    #[test]
    #[should_panic(expected = "Missing role")]
    fn reject_claim_requires_claims_mgr() {
        let f = AuthFixture::new();
        f.contribute();
        f.file_claim("c2");
        f.client()
            .reject_claim(&f.stranger, &Symbol::new(&f.env, "c2"));
    }

    #[test]
    #[should_panic(expected = "Missing role")]
    fn pay_claim_requires_claims_mgr() {
        let f = AuthFixture::new();
        f.contribute();
        f.file_claim("c3");
        f.approve_claim("c3");
        f.client()
            .pay_claim(&f.stranger, &Symbol::new(&f.env, "c3"), &f.token);
    }

    #[test]
    #[should_panic(expected = "Missing role")]
    fn rebalance_pool_requires_admin() {
        let f = AuthFixture::new();
        f.client().rebalance_pool(&f.stranger, &f.token, &600);
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
    fn contribute_while_paused() {
        let f = AuthFixture::new();
        f.client().pause(&f.pauser);
        f.client().contribute(&f.member, &f.token, &100);
    }

    #[test]
    #[should_panic(expected = "Contract is paused")]
    fn file_claim_while_paused() {
        let f = AuthFixture::new();
        f.client().pause(&f.pauser);
        f.client()
            .file_claim(&f.member, &Symbol::new(&f.env, "p1"), &100);
    }

    #[test]
    #[should_panic(expected = "Contract is paused")]
    fn approve_claim_while_paused() {
        let f = AuthFixture::new();
        f.contribute();
        f.file_claim("p2");
        f.client().pause(&f.pauser);
        f.client()
            .approve_claim(&f.claims_mgr, &Symbol::new(&f.env, "p2"));
    }

    #[test]
    #[should_panic(expected = "Contract is paused")]
    fn reject_claim_while_paused() {
        let f = AuthFixture::new();
        f.contribute();
        f.file_claim("p3");
        f.client().pause(&f.pauser);
        f.client()
            .reject_claim(&f.claims_mgr, &Symbol::new(&f.env, "p3"));
    }

    #[test]
    #[should_panic(expected = "Contract is paused")]
    fn pay_claim_while_paused() {
        let f = AuthFixture::new();
        f.contribute();
        f.file_claim("p4");
        f.approve_claim("p4");
        f.client().pause(&f.pauser);
        f.client()
            .pay_claim(&f.claims_mgr, &Symbol::new(&f.env, "p4"), &f.token);
    }
}

// =============================================================================
// Boundary tests
// =============================================================================

mod boundary {
    use super::*;

    #[test]
    #[should_panic(expected = "Amount must be positive")]
    fn contribute_zero_amount() {
        let f = AuthFixture::new();
        f.client().contribute(&f.member, &f.token, &0);
    }

    #[test]
    #[should_panic(expected = "Amount must be positive")]
    fn file_claim_zero_amount() {
        let f = AuthFixture::new();
        f.client()
            .file_claim(&f.member, &Symbol::new(&f.env, "z1"), &0);
    }

    #[test]
    #[should_panic(expected = "Premium exceeds maximum")]
    fn initialize_premium_too_high() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        InsurancePoolContractClient::new(&env, &env.register_contract(None, InsurancePoolContract))
            .initialize(&admin, &token, &10_001);
    }

    #[test]
    #[should_panic(expected = "Premium exceeds maximum")]
    fn rebalance_pool_premium_too_high() {
        let f = AuthFixture::new();
        f.client().rebalance_pool(&f.admin, &f.token, &10_001);
    }

    #[test]
    fn rebalance_pool_premium_at_max() {
        let f = AuthFixture::new();
        f.client().rebalance_pool(&f.admin, &f.token, &10_000);
        let stats = f.client().get_pool_stats(&f.token);
        assert_eq!(stats.premium_bps, 10_000);
    }

    #[test]
    fn rebalance_pool_premium_at_min() {
        let f = AuthFixture::new();
        f.client().rebalance_pool(&f.admin, &f.token, &0);
        let stats = f.client().get_pool_stats(&f.token);
        assert_eq!(stats.premium_bps, 0);
    }
}

// =============================================================================
// Contribution tests (member map storage)
// =============================================================================

mod contributions {
    use super::*;

    fn member_of(f: &AuthFixture, who: &Address) -> PoolMember {
        f.client().get_pool_member(who).expect("member recorded")
    }

    #[test]
    fn first_contribution_records_member() {
        let f = AuthFixture::new();
        f.env.ledger().set_timestamp(1_000);

        f.contribute_from(&f.member, 50_000);

        let member = member_of(&f, &f.member);
        assert_eq!(member.address, f.member);
        assert_eq!(member.contribution, 50_000);
        assert_eq!(member.last_contribution_at, 1_000);
        assert_eq!(f.client().get_pool_members().len(), 1);

        let stats = f.client().get_pool_stats(&f.token);
        assert_eq!(stats.total_contributions, 50_000);
        assert_eq!(stats.total_balance, 50_000);
    }

    #[test]
    fn repeat_contribution_accumulates_into_one_entry() {
        let f = AuthFixture::new();
        f.env.ledger().set_timestamp(1_000);
        f.contribute_from(&f.member, 50_000);

        f.env.ledger().set_timestamp(2_000);
        f.contribute_from(&f.member, 25_000);

        let member = member_of(&f, &f.member);
        assert_eq!(member.contribution, 75_000);
        assert_eq!(member.last_contribution_at, 2_000);
        assert_eq!(
            f.client().get_pool_members().len(),
            1,
            "repeat contributions must not create a second member entry"
        );

        let stats = f.client().get_pool_stats(&f.token);
        assert_eq!(stats.total_contributions, 75_000);
    }

    #[test]
    fn multiple_members_are_tracked_independently() {
        let f = AuthFixture::new();
        let second = Address::generate(&f.env);
        let third = Address::generate(&f.env);

        f.contribute_from(&f.member, 10_000);
        f.contribute_from(&second, 20_000);
        f.contribute_from(&third, 30_000);
        f.contribute_from(&second, 5_000);

        assert_eq!(member_of(&f, &f.member).contribution, 10_000);
        assert_eq!(member_of(&f, &second).contribution, 25_000);
        assert_eq!(member_of(&f, &third).contribution, 30_000);
        assert_eq!(f.client().get_pool_members().len(), 3);

        let stats = f.client().get_pool_stats(&f.token);
        assert_eq!(stats.total_contributions, 65_000);
    }

    #[test]
    fn unknown_address_has_no_member_entry() {
        let f = AuthFixture::new();
        f.contribute_from(&f.member, 10_000);

        assert!(f.client().get_pool_member(&f.stranger).is_none());
    }
}

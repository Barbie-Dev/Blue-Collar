//! # BlueCollar Insurance Pool Contract
//!
//! On-chain insurance pool for protecting worker payments.
//! Manages contributions, claims, and pool rebalancing.

#![no_std]
// soroban-sdk 26 deprecates `Events::publish` in favour of the `#[contractevent]`
// macro, and `Env::register_contract` in favour of `Env::register`. Migrating the
// event API changes the on-chain event ABI, so both are deliberately deferred to a
// dedicated upgrade rather than mixed into unrelated changes.
#![allow(deprecated)]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env, Map, String,
    Symbol, Vec,
};

/// Maximum allowed premium: 10000 bps = 100%.
pub const MAX_PREMIUM_BPS: u32 = 10000;

/// Event schema version — bump when adding/removing/renaming events.
pub const VERSION: u32 = 1;

// =============================================================================
// Roles
// =============================================================================

pub const ROLE_ADMIN: &str = "admin";
pub const ROLE_PAUSER: &str = "pauser";
pub const ROLE_CLAIMS_MGR: &str = "claims_mgr";
pub const ROLE_UPGRADER: &str = "upgrader";

// =============================================================================
// Types
// =============================================================================

/// Insurance pool member.
#[contracttype]
#[derive(Clone)]
pub struct PoolMember {
    /// Member address.
    pub address: Address,
    /// Contribution amount.
    pub contribution: i128,
    /// Timestamp of last contribution.
    pub last_contribution_at: u64,
}

/// Insurance claim.
#[contracttype]
#[derive(Clone)]
pub struct Claim {
    /// Claim ID.
    pub id: Symbol,
    /// Claimant address.
    pub claimant: Address,
    /// Claim amount.
    pub amount: i128,
    /// Claim status: "pending", "approved", "rejected", "paid".
    pub status: String,
    /// Timestamp when claim was filed.
    pub filed_at: u64,
    /// Timestamp when claim was resolved.
    pub resolved_at: u64,
}

/// Pool statistics.
#[contracttype]
#[derive(Clone)]
pub struct PoolStats {
    /// Token contract address.
    pub token: Address,
    /// Total pool balance.
    pub total_balance: i128,
    /// Total contributions.
    pub total_contributions: i128,
    /// Total claims paid.
    pub total_claims_paid: i128,
    /// Premium rate in basis points.
    pub premium_bps: u32,
}

/// Storage keys.
#[contracttype]
pub enum DataKey {
    /// Instance storage — admin address.
    Admin,
    /// Instance storage — paused flag.
    Paused,
    /// Persistent storage — role members.
    RoleMembers(Symbol),
    /// Persistent storage — pool members, keyed by member address.
    PoolMembers,
    /// Persistent storage — pool statistics.
    PoolStats(Address),
    /// Persistent storage — claims list.
    Claims,
    /// Persistent storage — individual claim.
    Claim(Symbol),
}

// =============================================================================
// Contract
// =============================================================================

#[contract]
pub struct InsurancePoolContract;

#[contractimpl]
impl InsurancePoolContract {
    /// Initialize the contract with an admin and token.
    pub fn initialize(env: Env, admin: Address, token: Address, premium_bps: u32) {
        assert!(
            !env.storage().instance().has(&DataKey::Admin),
            "Already initialized"
        );
        assert!(premium_bps <= MAX_PREMIUM_BPS, "Premium exceeds maximum");

        env.storage().instance().set(&DataKey::Admin, &admin);
        let role = Symbol::new(&env, ROLE_ADMIN);
        let mut members: Vec<Address> = Vec::new(&env);
        members.push_back(admin.clone());
        env.storage()
            .persistent()
            .set(&DataKey::RoleMembers(role.clone()), &members);

        let stats = PoolStats {
            token: token.clone(),
            total_balance: 0,
            total_contributions: 0,
            total_claims_paid: 0,
            premium_bps,
        };
        env.storage()
            .persistent()
            .set(&DataKey::PoolStats(token.clone()), &stats);

        env.events()
            .publish((symbol_short!("Init"), admin, premium_bps), ());
    }

    /// Get role members.
    fn get_role_members(env: &Env, role: &Symbol) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::RoleMembers(role.clone()))
            .unwrap_or(Vec::new(env))
    }

    /// Require role authorization.
    fn require_role(env: &Env, role: &Symbol, caller: &Address) {
        caller.require_auth();
        let members = Self::get_role_members(env, role);
        assert!(members.iter().any(|m| m == *caller), "Missing role");
    }

    /// Require contract not paused.
    fn require_not_paused(env: &Env) {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        assert!(!paused, "Contract is paused");
    }

    /// Grant a role to an address.
    pub fn grant_role(env: Env, caller: Address, role: Symbol, account: Address) {
        let admin_role = Symbol::new(&env, ROLE_ADMIN);
        Self::require_role(&env, &admin_role, &caller);
        Self::require_not_paused(&env);

        let mut members = Self::get_role_members(&env, &role);
        if members.iter().all(|m| m != account) {
            members.push_back(account.clone());
            env.storage()
                .persistent()
                .set(&DataKey::RoleMembers(role.clone()), &members);
        }
        env.events()
            .publish((symbol_short!("RlGrnt"), role, account), ());
    }

    /// Revoke a role from an address.
    pub fn revoke_role(env: Env, caller: Address, role: Symbol, account: Address) {
        let admin_role = Symbol::new(&env, ROLE_ADMIN);
        Self::require_role(&env, &admin_role, &caller);
        Self::require_not_paused(&env);

        let members = Self::get_role_members(&env, &role);
        let mut updated: Vec<Address> = Vec::new(&env);
        let mut found = false;
        for m in members.iter() {
            if m == account {
                found = true;
            } else {
                updated.push_back(m);
            }
        }
        assert!(found, "Account does not hold role");
        env.storage()
            .persistent()
            .set(&DataKey::RoleMembers(role.clone()), &updated);
        env.events()
            .publish((symbol_short!("RlRvkd"), role, account), ());
    }

    /// Pause the contract.
    pub fn pause(env: Env, caller: Address) {
        let pauser_role = Symbol::new(&env, ROLE_PAUSER);
        Self::require_role(&env, &pauser_role, &caller);
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((symbol_short!("Paused"), caller), ());
    }

    /// Unpause the contract.
    pub fn unpause(env: Env, caller: Address) {
        let admin_role = Symbol::new(&env, ROLE_ADMIN);
        Self::require_role(&env, &admin_role, &caller);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events()
            .publish((symbol_short!("Unpaused"), caller), ());
    }

    /// Contribute to the insurance pool.
    pub fn contribute(env: Env, contributor: Address, token: Address, amount: i128) {
        Self::require_not_paused(&env);
        assert!(amount > 0, "Amount must be positive");

        contributor.require_auth();

        let token_client = token::Client::new(&env, &token);
        token_client.transfer_from(
            &env.current_contract_address(),
            &contributor,
            &env.current_contract_address(),
            &amount,
        );

        let now = env.ledger().timestamp();
        let mut members = Self::load_pool_members(&env);
        let member = match members.get(contributor.clone()) {
            Some(mut existing) => {
                existing.contribution = existing.contribution.saturating_add(amount);
                existing.last_contribution_at = now;
                existing
            }
            None => PoolMember {
                address: contributor.clone(),
                contribution: amount,
                last_contribution_at: now,
            },
        };
        members.set(contributor.clone(), member);

        env.storage()
            .persistent()
            .set(&DataKey::PoolMembers, &members);

        let mut stats: PoolStats = env
            .storage()
            .persistent()
            .get(&DataKey::PoolStats(token.clone()))
            .unwrap_or_else(|| PoolStats {
                token: token.clone(),
                total_balance: 0,
                total_contributions: 0,
                total_claims_paid: 0,
                premium_bps: 0,
            });

        stats.total_balance = stats.total_balance.saturating_add(amount);
        stats.total_contributions = stats.total_contributions.saturating_add(amount);
        env.storage()
            .persistent()
            .set(&DataKey::PoolStats(token.clone()), &stats);

        env.events()
            .publish((symbol_short!("Contrib"), contributor, amount), ());
    }

    /// File an insurance claim.
    pub fn file_claim(env: Env, claimant: Address, claim_id: Symbol, amount: i128) {
        Self::require_not_paused(&env);
        assert!(amount > 0, "Amount must be positive");

        claimant.require_auth();

        let claim = Claim {
            id: claim_id.clone(),
            claimant: claimant.clone(),
            amount,
            status: String::from_slice(&env, "pending"),
            filed_at: env.ledger().timestamp(),
            resolved_at: 0,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Claim(claim_id.clone()), &claim);

        let mut claims: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&DataKey::Claims)
            .unwrap_or(Vec::new(&env));
        claims.push_back(claim_id.clone());
        env.storage().persistent().set(&DataKey::Claims, &claims);

        env.events()
            .publish((symbol_short!("ClmFile"), claimant, amount), ());
    }

    /// Approve an insurance claim.
    pub fn approve_claim(env: Env, caller: Address, claim_id: Symbol) {
        let claims_mgr_role = Symbol::new(&env, ROLE_CLAIMS_MGR);
        Self::require_role(&env, &claims_mgr_role, &caller);
        Self::require_not_paused(&env);

        let mut claim: Claim = env
            .storage()
            .persistent()
            .get(&DataKey::Claim(claim_id.clone()))
            .expect("Claim not found");

        assert!(
            claim.status == String::from_slice(&env, "pending"),
            "Claim not pending"
        );

        claim.status = String::from_slice(&env, "approved");
        claim.resolved_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Claim(claim_id.clone()), &claim);

        env.events()
            .publish((symbol_short!("ClmAppr"), claim_id, claim.amount), ());
    }

    /// Reject an insurance claim.
    pub fn reject_claim(env: Env, caller: Address, claim_id: Symbol) {
        let claims_mgr_role = Symbol::new(&env, ROLE_CLAIMS_MGR);
        Self::require_role(&env, &claims_mgr_role, &caller);
        Self::require_not_paused(&env);

        let mut claim: Claim = env
            .storage()
            .persistent()
            .get(&DataKey::Claim(claim_id.clone()))
            .expect("Claim not found");

        assert!(
            claim.status == String::from_slice(&env, "pending"),
            "Claim not pending"
        );

        claim.status = String::from_slice(&env, "rejected");
        claim.resolved_at = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&DataKey::Claim(claim_id.clone()), &claim);

        env.events()
            .publish((symbol_short!("ClmRej"), claim_id, claim.amount), ());
    }

    /// Pay out an approved claim.
    pub fn pay_claim(env: Env, caller: Address, claim_id: Symbol, token: Address) {
        let claims_mgr_role = Symbol::new(&env, ROLE_CLAIMS_MGR);
        Self::require_role(&env, &claims_mgr_role, &caller);
        Self::require_not_paused(&env);

        let mut claim: Claim = env
            .storage()
            .persistent()
            .get(&DataKey::Claim(claim_id.clone()))
            .expect("Claim not found");

        assert!(
            claim.status == String::from_slice(&env, "approved"),
            "Claim not approved"
        );

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(
            &env.current_contract_address(),
            &claim.claimant,
            &claim.amount,
        );

        claim.status = String::from_slice(&env, "paid");
        env.storage()
            .persistent()
            .set(&DataKey::Claim(claim_id.clone()), &claim);

        let mut stats: PoolStats = env
            .storage()
            .persistent()
            .get(&DataKey::PoolStats(token.clone()))
            .expect("Pool stats not found");

        stats.total_balance = stats.total_balance.saturating_sub(claim.amount);
        stats.total_claims_paid = stats.total_claims_paid.saturating_add(claim.amount);
        env.storage()
            .persistent()
            .set(&DataKey::PoolStats(token.clone()), &stats);

        env.events()
            .publish((symbol_short!("ClmPay"), claim_id, claim.amount), ());
    }

    /// Get pool statistics.
    pub fn get_pool_stats(env: Env, token: Address) -> PoolStats {
        env.storage()
            .persistent()
            .get(&DataKey::PoolStats(token.clone()))
            .unwrap_or(PoolStats {
                token,
                total_balance: 0,
                total_contributions: 0,
                total_claims_paid: 0,
                premium_bps: 0,
            })
    }

    /// Get every pool member.
    pub fn get_pool_members(env: Env) -> Vec<PoolMember> {
        Self::load_pool_members(&env).values()
    }

    /// Get a single pool member, or `None` if the address never contributed.
    pub fn get_pool_member(env: Env, address: Address) -> Option<PoolMember> {
        Self::load_pool_members(&env).get(address)
    }

    /// Read the member map, defaulting to an empty map.
    fn load_pool_members(env: &Env) -> Map<Address, PoolMember> {
        env.storage()
            .persistent()
            .get(&DataKey::PoolMembers)
            .unwrap_or(Map::new(env))
    }

    /// Get a specific claim.
    pub fn get_claim(env: Env, claim_id: Symbol) -> Claim {
        env.storage()
            .persistent()
            .get(&DataKey::Claim(claim_id))
            .expect("Claim not found")
    }

    /// Rebalance pool by adjusting premium.
    pub fn rebalance_pool(env: Env, caller: Address, token: Address, new_premium_bps: u32) {
        let admin_role = Symbol::new(&env, ROLE_ADMIN);
        Self::require_role(&env, &admin_role, &caller);
        assert!(
            new_premium_bps <= MAX_PREMIUM_BPS,
            "Premium exceeds maximum"
        );

        let mut stats: PoolStats = env
            .storage()
            .persistent()
            .get(&DataKey::PoolStats(token.clone()))
            .expect("Pool stats not found");

        stats.premium_bps = new_premium_bps;
        env.storage()
            .persistent()
            .set(&DataKey::PoolStats(token.clone()), &stats);

        env.events()
            .publish((symbol_short!("Rebal"), token, new_premium_bps as i128), ());
    }

    /// Return the event schema version.
    pub fn version(_env: Env) -> u32 {
        VERSION
    }

    /// Upgrade contract WASM.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        let upgrader_role = Symbol::new(&env, ROLE_UPGRADER);
        Self::require_role(&env, &upgrader_role, &caller);
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        env.events().publish((symbol_short!("Upgrade"), caller), ());
    }
}

#[cfg(test)]
mod test;

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        env.register_stellar_asset_contract_v2(token.clone());
        let contract = env.register_contract(None, InsurancePoolContract);
        let client = InsurancePoolContractClient::new(&env, &contract);
        client.initialize(&admin, &token, &100);
        assert!(env.as_contract(&contract, || {
            env.storage().instance().has(&DataKey::Admin)
        }));
    }
}

//! # BlueCollar Payment Contract
//!
//! Handles direct payments and milestone-based locked payments between clients
//! and workers on the Stellar/Soroban network.
//!
//! ## Functions
//! - `pay` — direct single-shot payment with optional protocol fee.
//! - `lock_payment` — lock funds for a job milestone; released on completion.
//! - `release_payment` — release locked funds to the worker (client or admin).
//! - `refund_payment` — refund locked funds to the client (admin only, or expired).
//! - Admin management: `initialize`, `update_fee`, `set_treasury`, `pause`, `unpause`.
//!
//! ## Access Control
//! - `ROLE_ADMIN`: full admin; grant/revoke roles, upgrade.
//! - `ROLE_FEE_MGR`: update protocol fee.
//! - `ROLE_PAUSER`: pause/unpause.
//!
//! ## Security (CEI ordering)
//! Every state-mutating function follows Checks → Effects → Interactions.
//! No external calls occur before storage is updated.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env, Symbol, Vec};
use bluecollar_types::{storage::extend_ttl, ContractError};

/// Maximum protocol fee: 500 bps = 5 %.
pub const MAX_FEE_BPS: u32 = 500;

pub const VERSION: u32 = 1;

// =============================================================================
// Roles
// =============================================================================

pub const ROLE_ADMIN: &str = "admin";
pub const ROLE_FEE_MGR: &str = "fee_mgr";
pub const ROLE_PAUSER: &str = "pauser";
pub const ROLE_UPGRADER: &str = "upgrader";

const ROLE_ADMIN_ID: u64 = 0;
const ROLE_FEE_MGR_ID: u64 = 1;
const ROLE_PAUSER_ID: u64 = 2;
const ROLE_UPGRADER_ID: u64 = 3;

fn role_to_id(env: &Env, role: &Symbol) -> u64 {
    if *role == Symbol::new(env, ROLE_ADMIN) {
        ROLE_ADMIN_ID
    } else if *role == Symbol::new(env, ROLE_FEE_MGR) {
        ROLE_FEE_MGR_ID
    } else if *role == Symbol::new(env, ROLE_PAUSER) {
        ROLE_PAUSER_ID
    } else if *role == Symbol::new(env, ROLE_UPGRADER) {
        ROLE_UPGRADER_ID
    } else {
        u64::MAX
    }
}

// =============================================================================
// Types
// =============================================================================

/// Protocol configuration stored in instance storage.
#[contracttype]
#[derive(Clone)]
pub struct Config {
    /// Protocol fee in basis points (0–500).
    pub fee_bps: u32,
    /// Address that receives collected protocol fees.
    pub fee_recipient: Address,
}

/// Status of a locked payment.
#[contracttype]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaymentStatus {
    /// Funds locked; awaiting release or refund.
    Locked = 0,
    /// Funds released to the worker.
    Released = 1,
    /// Funds refunded to the client.
    Refunded = 2,
}

/// A locked payment record stored in persistent storage.
#[contracttype]
#[derive(Clone)]
pub struct LockedPayment {
    /// Unique identifier (caller-supplied).
    pub id: Symbol,
    /// Client that locked the funds.
    pub client: Address,
    /// Worker that will receive funds on release.
    pub worker: Address,
    /// Token contract address.
    pub token: Address,
    /// Locked amount in smallest token units.
    pub amount: i128,
    /// Unix timestamp after which client may self-refund without admin.
    pub expiry: u64,
    /// Current status.
    pub status: PaymentStatus,
}

/// Storage keys.
#[contracttype]
pub enum DataKey {
    /// Instance — config (fee_bps, fee_recipient).
    Config,
    /// Instance — paused flag.
    Paused,
    /// Persistent — admin address.
    Admin,
    /// Persistent — role member lists.
    RoleMembers(u64),
    /// Persistent — locked payment record.
    Payment(Symbol),
    /// Persistent — schema version.
    SchemaVersion,
}

// =============================================================================
// Contract
// =============================================================================

#[contract]
pub struct PaymentContract;

#[contractimpl]
impl PaymentContract {
    // -------------------------------------------------------------------------
    // Initialise
    // -------------------------------------------------------------------------

    /// Initialise the contract.
    ///
    /// # Panics
    /// - `"Already initialized"` if called more than once.
    /// - `"fee_bps exceeds maximum (500)"` if `fee_bps > MAX_FEE_BPS`.
    pub fn initialize(env: Env, admin: Address, fee_bps: u32, fee_recipient: Address) {
        // --- Checks ---
        assert!(
            !env.storage().instance().has(&DataKey::Config),
            ContractError::ALREADY_INITIALIZED
        );
        assert!(fee_bps <= MAX_FEE_BPS, ContractError::FEE_BPS_EXCEEDS_MAXIMUM);

        // --- Effects ---
        let config = Config { fee_bps, fee_recipient };
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::SchemaVersion, &1u32);

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
    // Internal helpers
    // -------------------------------------------------------------------------

    fn get_role_members(env: &Env, role: &Symbol) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::RoleMembers(role_to_id(env, role)))
            .unwrap_or(Vec::new(env))
    }

    fn require_role(env: &Env, role: &Symbol, caller: &Address) {
        caller.require_auth();
        let members = Self::get_role_members(env, role);
        assert!(members.iter().any(|m| m == *caller), ContractError::MISSING_ROLE);
    }

    fn require_not_paused(env: &Env) {
        assert!(
            !env.storage()
                .instance()
                .get::<_, bool>(&DataKey::Paused)
                .unwrap_or(false),
            ContractError::CONTRACT_IS_PAUSED
        );
    }

    fn get_config(env: &Env) -> Config {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .expect("Not initialized")
    }

    fn compute_fee(amount: i128, fee_bps: u32) -> (i128, i128) {
        if fee_bps == 0 {
            return (0, amount);
        }
        let fee = amount
            .checked_mul(fee_bps as i128)
            .expect("overflow")
            .checked_div(10_000)
            .expect("div zero");
        let net = amount.checked_sub(fee).expect("underflow");
        (fee, net)
    }

    fn extend_payment_ttl(env: &Env, id: &Symbol) {
        extend_ttl(env, &DataKey::Payment(id.clone()));
    }

    // -------------------------------------------------------------------------
    // Admin
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

    /// Return `true` if `account` holds `role`.
    pub fn has_role(env: Env, role: Symbol, account: Address) -> bool {
        Self::get_role_members(&env, &role)
            .iter()
            .any(|m| m == account)
    }

    /// Update the protocol fee. Caller must hold `ROLE_FEE_MGR`.
    ///
    /// # Panics
    /// - `"fee_bps exceeds maximum (500)"` if `new_fee_bps > MAX_FEE_BPS`.
    /// - `"Missing role"` if caller does not hold `ROLE_FEE_MGR`.
    pub fn update_fee(env: Env, caller: Address, new_fee_bps: u32) {
        Self::require_role(&env, &Symbol::new(&env, ROLE_FEE_MGR), &caller);
        assert!(new_fee_bps <= MAX_FEE_BPS, ContractError::FEE_BPS_EXCEEDS_MAXIMUM);
        let mut config = Self::get_config(&env);
        config.fee_bps = new_fee_bps;
        env.storage().instance().set(&DataKey::Config, &config);
        env.events()
            .publish((symbol_short!("FeeUpd"), caller), new_fee_bps);
    }

    /// Update the treasury (fee recipient). Caller must hold `ROLE_ADMIN`.
    pub fn set_treasury(env: Env, caller: Address, new_treasury: Address) {
        Self::require_role(&env, &Symbol::new(&env, ROLE_ADMIN), &caller);
        let mut config = Self::get_config(&env);
        config.fee_recipient = new_treasury.clone();
        env.storage().instance().set(&DataKey::Config, &config);
        env.events()
            .publish((symbol_short!("TrsSet"), caller), new_treasury);
    }

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
        env.events()
            .publish((symbol_short!("Unpaused"), caller), ());
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect(ContractError::NOT_INITIALIZED)
    }

    pub fn get_config_view(env: Env) -> Config {
        Self::get_config(&env)
    }

    // -------------------------------------------------------------------------
    // Versioning
    // -------------------------------------------------------------------------

    /// Return the event schema version.
    pub fn version(_env: Env) -> u32 {
        VERSION
    }

    // -------------------------------------------------------------------------
    // Direct payment
    // -------------------------------------------------------------------------

    /// Send a direct payment to a worker, deducting the protocol fee.
    ///
    /// # Parameters
    /// - `from`: Payer; `require_auth()` enforced.
    /// - `to`: Worker receiving funds.
    /// - `token_addr`: Stellar token contract address.
    /// - `amount`: Total amount (fee deducted from this).
    ///
    /// # Panics
    /// - `"Amount must be positive"` if `amount <= 0`.
    /// - `"Not initialized"` if contract not yet initialised.
    /// - `"Contract is paused"` if paused.
    pub fn pay(env: Env, from: Address, to: Address, token_addr: Address, amount: i128) {
        // --- Checks ---
        Self::require_not_paused(&env);
        from.require_auth();
        assert!(amount > 0, ContractError::AMOUNT_MUST_BE_POSITIVE);
        let config = Self::get_config(&env);

        // --- Effects (compute fee split) ---
        let (fee, net) = Self::compute_fee(amount, config.fee_bps);

        // --- Interactions ---
        let token = token::Client::new(&env, &token_addr);
        token.transfer(&from, &to, &net);
        if fee > 0 {
            token.transfer(&from, &config.fee_recipient, &fee);
        }
        env.events()
            .publish((symbol_short!("Pay"), from), (to, token_addr, amount, fee));
    }

    // -------------------------------------------------------------------------
    // Locked payments (milestone-based)
    // -------------------------------------------------------------------------

    /// Lock funds for a job milestone.
    ///
    /// The `from` address transfers `amount` tokens into the contract's custody.
    /// Funds are released by calling `release_payment` or refunded via `refund_payment`.
    ///
    /// # Panics
    /// - `"Already exists"` if `id` already has a locked payment.
    /// - `"Amount must be positive"` if `amount <= 0`.
    /// - `"expiry must be in future"` if `expiry <= current timestamp`.
    /// - `"Contract is paused"` if paused.
    pub fn lock_payment(
        env: Env,
        from: Address,
        to: Address,
        token_addr: Address,
        id: Symbol,
        amount: i128,
        expiry: u64,
    ) {
        // --- Checks ---
        Self::require_not_paused(&env);
        from.require_auth();
        assert!(amount > 0, ContractError::AMOUNT_MUST_BE_POSITIVE);
        assert!(
            expiry > env.ledger().timestamp(),
            ContractError::EXPIRY_MUST_BE_IN_FUTURE
        );
        assert!(
            !env.storage()
                .persistent()
                .has(&DataKey::Payment(id.clone())),
            ContractError::ALREADY_EXISTS
        );

        // --- Effects ---
        let record = LockedPayment {
            id: id.clone(),
            client: from.clone(),
            worker: to.clone(),
            token: token_addr.clone(),
            amount,
            expiry,
            status: PaymentStatus::Locked,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Payment(id.clone()), &record);
        Self::extend_payment_ttl(&env, &id);

        // --- Interactions ---
        let token = token::Client::new(&env, &token_addr);
        token.transfer(&from, &env.current_contract_address(), &amount);
        env.events()
            .publish((symbol_short!("Locked"), id), (from, to, amount));
    }

    /// Release a locked payment to the worker.
    ///
    /// Only the client or the admin may call this.
    ///
    /// # Panics
    /// - `"Payment not found"` if id does not exist.
    /// - `"Not authorized"` if caller is neither the client nor an admin.
    /// - `"Payment not locked"` if already released or refunded.
    /// - `"Contract is paused"` if paused.
    pub fn release_payment(env: Env, caller: Address, id: Symbol) {
        // --- Checks ---
        Self::require_not_paused(&env);
        caller.require_auth();

        let mut record: LockedPayment = env
            .storage()
            .persistent()
            .get(&DataKey::Payment(id.clone()))
            .expect(ContractError::PAYMENT_NOT_FOUND);

        let is_client = record.client == caller;
        let is_admin = Self::get_role_members(&env, &Symbol::new(&env, ROLE_ADMIN))
            .iter()
            .any(|m| m == caller);
        assert!(is_client || is_admin, ContractError::NOT_AUTHORIZED);
        assert!(record.status == PaymentStatus::Locked, ContractError::PAYMENT_NOT_LOCKED);

        // --- Effects ---
        record.status = PaymentStatus::Released;
        env.storage()
            .persistent()
            .set(&DataKey::Payment(id.clone()), &record);
        Self::extend_payment_ttl(&env, &id);

        // --- Interactions ---
        let token = token::Client::new(&env, &record.token);
        token.transfer(&env.current_contract_address(), &record.worker, &record.amount);
        env.events().publish(
            (symbol_short!("Released"), id),
            (caller, record.worker, record.amount),
        );
    }

    /// Refund a locked payment to the client.
    ///
    /// Admin may refund at any time. The client may self-refund after expiry.
    ///
    /// # Panics
    /// - `"Payment not found"` if id does not exist.
    /// - `"Not authorized"` if caller is neither admin nor (client after expiry).
    /// - `"Payment not locked"` if already settled.
    /// - `"Contract is paused"` if paused.
    pub fn refund_payment(env: Env, caller: Address, id: Symbol) {
        // --- Checks ---
        Self::require_not_paused(&env);
        caller.require_auth();

        let mut record: LockedPayment = env
            .storage()
            .persistent()
            .get(&DataKey::Payment(id.clone()))
            .expect(ContractError::PAYMENT_NOT_FOUND);

        assert!(record.status == PaymentStatus::Locked, "Payment not locked");

        let is_admin = Self::get_role_members(&env, &Symbol::new(&env, ROLE_ADMIN))
            .iter()
            .any(|m| m == caller);
        let is_expired_client =
            record.client == caller && env.ledger().timestamp() >= record.expiry;
        assert!(is_admin || is_expired_client, "Not authorized");

        // --- Effects ---
        record.status = PaymentStatus::Refunded;
        env.storage()
            .persistent()
            .set(&DataKey::Payment(id.clone()), &record);
        Self::extend_payment_ttl(&env, &id);

        // --- Interactions ---
        let token = token::Client::new(&env, &record.token);
        token.transfer(&env.current_contract_address(), &record.client, &record.amount);
        env.events().publish(
            (symbol_short!("Refunded"), id),
            (caller, record.client, record.amount),
        );
    }

    /// Get a locked payment record by id.
    ///
    /// # Panics
    /// - `"Payment not found"` if id does not exist.
    pub fn get_payment(env: Env, id: Symbol) -> LockedPayment {
        env.storage()
            .persistent()
            .get(&DataKey::Payment(id))
            .expect(ContractError::PAYMENT_NOT_FOUND)
    }

    /// Extend the TTL of a payment entry (permissionless).
    pub fn extend_payment_ttl_pub(env: Env, id: Symbol) {
        Self::extend_payment_ttl(&env, &id);
    }

    // -------------------------------------------------------------------------
    // Upgrade
    // -------------------------------------------------------------------------

    /// Upgrade the contract WASM. Caller must hold `ROLE_UPGRADER`.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        Self::require_role(&env, &Symbol::new(&env, ROLE_UPGRADER), &caller);
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod test;

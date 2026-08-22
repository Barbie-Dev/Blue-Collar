//! Shared error definitions for BlueCollar contracts.
//!
//! Consolidates common error codes across all contracts to ensure consistency
//! and maintainability. Error messages are defined as string constants to avoid
//! duplication across multiple contracts.

/// Common error messages for BlueCollar contracts.
pub struct ContractError;

impl ContractError {
    // =========================================================================
    // Initialization errors
    // =========================================================================

    pub const ALREADY_INITIALIZED: &'static str = "Already initialized";
    pub const NOT_INITIALIZED: &'static str = "Not initialized";

    // =========================================================================
    // Authorization errors
    // =========================================================================

    pub const NOT_AUTHORIZED: &'static str = "Not authorized";
    pub const MISSING_ROLE: &'static str = "Missing role";
    pub const NOT_ADMIN: &'static str = "Not admin";
    pub const NOT_A_PARTY: &'static str = "Not a party";
    pub const NOT_A_SIGNER: &'static str = "Not a signer";
    pub const NOT_AN_ARBITRATOR: &'static str = "Not an arbitrator";
    pub const UNAUTHORIZED_CALLER: &'static str = "Unauthorized caller";

    // =========================================================================
    // Resource not found errors
    // =========================================================================

    pub const ESCROW_NOT_FOUND: &'static str = "Escrow not found";
    pub const PAYMENT_NOT_FOUND: &'static str = "Payment not found";
    pub const WORKER_NOT_FOUND: &'static str = "Worker not found";
    pub const DISPUTE_NOT_FOUND: &'static str = "Dispute not found";
    pub const ARBITRATION_NOT_FOUND: &'static str = "Arbitration not found";
    pub const JOB_NOT_FOUND: &'static str = "Job not found";
    pub const BADGE_NOT_FOUND: &'static str = "Badge not found";
    pub const CERTIFICATION_NOT_FOUND: &'static str = "Certification not found";
    pub const CLAIM_NOT_FOUND: &'static str = "Claim not found";
    pub const DELEGATE_NOT_FOUND: &'static str = "Delegate not found";
    pub const SKILL_NOT_FOUND: &'static str = "Skill not found";

    // =========================================================================
    // Existence/duplication errors
    // =========================================================================

    pub const ALREADY_EXISTS: &'static str = "Already exists";
    pub const ESCROW_ALREADY_EXISTS: &'static str = "Escrow already exists";
    pub const JOB_ALREADY_EXISTS: &'static str = "Job already exists";
    pub const DISPUTE_ID_ALREADY_EXISTS: &'static str = "Dispute id already exists";
    pub const MULTISIG_ESCROW_ALREADY_EXISTS: &'static str = "MultiSigEscrow id already exists";
    pub const CERTIFICATION_ALREADY_EXISTS: &'static str = "Certification already exists";
    pub const ALREADY_APPROVED: &'static str = "Already approved";

    // =========================================================================
    // State/Status errors
    // =========================================================================

    pub const ALREADY_RELEASED: &'static str = "Already released";
    pub const ALREADY_CANCELLED: &'static str = "Already cancelled";
    pub const ALREADY_RESOLVED: &'static str = "Already resolved";
    pub const ESCROW_FINALIZED: &'static str = "Escrow finalized";
    pub const ESCROW_NOT_ACTIVE: &'static str = "Escrow not active";
    pub const ESCROW_CANCELLED: &'static str = "Escrow cancelled";
    pub const ESCROW_NOT_DISPUTED: &'static str = "Escrow not disputed";
    pub const JOB_NOT_OPEN: &'static str = "Job not open";
    pub const JOB_NOT_ASSIGNED: &'static str = "Job not assigned";
    pub const PAYMENT_NOT_LOCKED: &'static str = "Payment not locked";
    pub const DISPUTE_NOT_OPEN_OR_IN_EVIDENCE: &'static str =
        "Dispute not open or in evidence phase";
    pub const NOT_DECIDED_YET: &'static str = "Not decided yet";
    pub const NOT_DECIDABLE: &'static str = "Not decidable";
    pub const ARBITRATION_ALREADY_REQUESTED: &'static str = "Arbitration already requested";

    // =========================================================================
    // Expiry/Time-based errors
    // =========================================================================

    pub const ESCROW_NOT_YET_EXPIRED: &'static str = "Escrow not yet expired";
    pub const EXPIRY_MUST_BE_IN_FUTURE: &'static str = "expiry must be in future";
    pub const CERTIFICATION_EXPIRED: &'static str = "Certification expired";
    pub const INVALID_EXPIRY: &'static str = "Invalid expiry";

    // =========================================================================
    // Validation errors
    // =========================================================================

    pub const AMOUNT_MUST_BE_POSITIVE: &'static str = "Amount must be positive";
    pub const AMOUNT_MUST_BE_POSITIVE_ALT: &'static str = "amount must be positive";
    pub const NO_ACTIVE_STAKE: &'static str = "No active stake";
    pub const NO_FEES_TO_DISTRIBUTE: &'static str = "No fees to distribute";
    pub const RATING_OUT_OF_RANGE: &'static str = "Rating out of range";
    pub const SCORE_OUT_OF_RANGE: &'static str = "Score out of range";
    pub const INVALID_SUBSCRIPTION_TIER: &'static str = "Invalid subscription tier";
    pub const BATCH_TOO_LARGE: &'static str = "Batch too large";
    pub const NO_FEE_RECIPIENTS_CONFIGURED: &'static str = "No fee recipients configured";

    // =========================================================================
    // Fee-related errors
    // =========================================================================

    pub const FEE_BPS_EXCEEDS_MAXIMUM: &'static str = "fee_bps exceeds maximum (500)";
    pub const PREMIUM_EXCEEDS_MAXIMUM: &'static str = "Premium exceeds maximum";
    pub const INVALID_FEE_SPLIT: &'static str = "Percentages must sum to 100%";

    // =========================================================================
    // Contract state errors
    // =========================================================================

    pub const CONTRACT_IS_PAUSED: &'static str = "Contract is paused";
    pub const UNSTAKE_ALREADY_REQUESTED: &'static str = "Unstake already requested";
    pub const UNSTAKE_NOT_REQUESTED: &'static str = "Unstake not requested";

    // =========================================================================
    // Data integrity errors
    // =========================================================================

    pub const WRONG_SCHEMA_VERSION: &'static str = "Wrong schema version";
}

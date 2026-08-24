//! Shared types for BlueCollar contracts.

#![no_std]

pub mod errors;
pub mod storage;
pub mod versioning;

pub use errors::ContractError;
pub use storage::{extend_ttl, TTL_EXTEND_TO, TTL_THRESHOLD};
pub use versioning::{ContractVersion, EventSchema, StorageSchema};

//! Shared types for BlueCollar contracts.

#![no_std]

pub mod errors;
pub mod versioning;

pub use errors::ContractError;
pub use versioning::{ContractVersion, EventSchema, StorageSchema};

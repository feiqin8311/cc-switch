//! Enterprise login / session.
//!
//! The desktop app talks to the CC Switch enterprise server
//! (contract: `enterprise/contracts/src/index.ts`, routes under `/api/v1`).
//! Tokens are owned here and never reach the webview: the refresh token is
//! persisted in `<app config dir>/enterprise_session.json` (0600), the access
//! token lives in memory only. Rust features that need authenticated calls use
//! [`EnterpriseSession::access_token`] / [`EnterpriseSession::send_authenticated`].

mod client;
#[cfg(test)]
mod e2e;
#[cfg(test)]
mod e2e_phases;
pub mod market;
pub mod providers;
mod retention;
mod server_url;
mod session;
mod types;

#[allow(unused_imports)] // re-exports for later enterprise features
pub use client::{endpoint, EnterpriseError, API_PREFIX};
pub use retention::{RetentionService, RetentionStatus};
#[allow(unused_imports)]
pub use server_url::normalize_server_url;
pub use session::EnterpriseSession;
pub use types::EnterpriseProviderMeta;
#[allow(unused_imports)]
pub use types::{
    ClientConfigResponse, EnterpriseState, ManagedModel, ManagedProvider, RetentionPolicy, User,
};

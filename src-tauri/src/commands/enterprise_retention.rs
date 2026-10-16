//! Conversation retention commands (enterprise Phase 3).
//!
//! The daily sync loop itself lives in [`crate::enterprise::RetentionService`];
//! this command only exposes its status.

use std::sync::Arc;

use tauri::State;

use crate::enterprise::{RetentionService, RetentionStatus};

/// Tauri-managed wrapper around the retention service.
pub struct EnterpriseRetentionState(pub Arc<RetentionService>);

/// Retention policy and sync status for the current account (no network).
#[tauri::command]
pub async fn enterprise_retention_status(
    state: State<'_, EnterpriseRetentionState>,
) -> Result<RetentionStatus, String> {
    Ok(state.0.status().await)
}

//! Conversation retention commands (enterprise Phase 3).
//!
//! The upload loop itself lives in [`crate::enterprise::RetentionService`];
//! these commands only expose its status and record the acknowledgment.

use std::sync::Arc;

use tauri::State;

use crate::enterprise::{RetentionService, RetentionStatus};

/// Tauri-managed wrapper around the retention service.
pub struct EnterpriseRetentionState(pub Arc<RetentionService>);

/// Retention policy, acknowledgment and upload status for the current account (no network).
#[tauri::command]
pub async fn enterprise_retention_status(
    state: State<'_, EnterpriseRetentionState>,
) -> Result<RetentionStatus, String> {
    Ok(state.0.status().await)
}

/// Record that the signed-in user acknowledged the retention notice on this
/// device and start uploading conversations started from now on.
#[tauri::command]
pub async fn enterprise_retention_acknowledge(
    state: State<'_, EnterpriseRetentionState>,
) -> Result<RetentionStatus, String> {
    state.0.acknowledge().await
}

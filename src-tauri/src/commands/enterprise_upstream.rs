//! Upstream Sub2API account windows, proxied by the enterprise server.

use tauri::State;

use super::EnterpriseSessionState;

#[tauri::command]
pub async fn enterprise_upstream_accounts(
    session: State<'_, EnterpriseSessionState>,
) -> Result<serde_json::Value, String> {
    session
        .0
        .get_json("/client/upstream/accounts")
        .await
        .map_err(|e| e.to_string())
}

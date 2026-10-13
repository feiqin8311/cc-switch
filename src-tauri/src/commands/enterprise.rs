//! Enterprise login Tauri commands.
//!
//! The webview only ever sees [`EnterpriseState`]; tokens stay in
//! [`EnterpriseSession`].

use std::sync::Arc;

use tauri::State;

use crate::enterprise::{EnterpriseSession, EnterpriseState};

/// Tauri-managed wrapper around the enterprise session.
pub struct EnterpriseSessionState(pub Arc<EnterpriseSession>);

/// Current enterprise state (no network).
#[tauri::command]
pub async fn enterprise_get_state(
    state: State<'_, EnterpriseSessionState>,
) -> Result<EnterpriseState, String> {
    Ok(state.0.state().await)
}

/// Log in to the enterprise server. Errors carry the server's message when present.
#[tauri::command(rename_all = "camelCase")]
pub async fn enterprise_login(
    state: State<'_, EnterpriseSessionState>,
    server_url: String,
    username: String,
    password: String,
) -> Result<EnterpriseState, String> {
    state
        .0
        .login(&server_url, &username, &password)
        .await
        .map_err(String::from)
}

/// Log out: always clears the local session; server revoke is best-effort.
#[tauri::command]
pub async fn enterprise_logout(
    state: State<'_, EnterpriseSessionState>,
) -> Result<EnterpriseState, String> {
    Ok(state.0.logout().await)
}

/// Re-fetch `GET /client/config`. Network / server failures are reported via
/// `lastError` / `offline` in the returned state; errors only when not signed in.
#[tauri::command]
pub async fn enterprise_refresh_config(
    state: State<'_, EnterpriseSessionState>,
) -> Result<EnterpriseState, String> {
    state.0.refresh_config().await.map_err(String::from)
}

/// Set the `model` of a Codex provider card. Enterprise-managed cards accept
/// only the models the server offers; the live config is re-applied when the
/// card is in use. Returns whether anything changed.
#[tauri::command(rename_all = "camelCase")]
pub async fn codex_set_provider_model(
    app: tauri::AppHandle,
    provider_id: String,
    model: String,
) -> Result<bool, String> {
    crate::enterprise::providers::set_provider_model(&app, provider_id, model).await
}

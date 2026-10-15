//! Enterprise marketplace Tauri commands (skills and Codex plugins).

use tauri::State;

use super::EnterpriseSessionState;
use crate::enterprise::market::{self, MarketItem, MarketListEntry, MarketPaths};
use crate::store::AppState;

/// Marketplace items with install state. Empty when not signed in or without
/// `market.install`.
#[tauri::command]
pub async fn enterprise_market_list(
    session: State<'_, EnterpriseSessionState>,
    app_state: State<'_, AppState>,
) -> Result<Vec<MarketListEntry>, String> {
    market::list(&session.0, &app_state.db, &MarketPaths::from_app_config()).await
}

/// Install (or update) a marketplace item.
#[tauri::command]
pub async fn enterprise_market_install(
    id: String,
    session: State<'_, EnterpriseSessionState>,
    app_state: State<'_, AppState>,
) -> Result<MarketListEntry, String> {
    market::install(
        &session.0,
        &app_state.db,
        &MarketPaths::from_app_config(),
        &id,
    )
    .await
}

/// Uninstall a marketplace item. Mandatory items are refused.
#[tauri::command]
pub async fn enterprise_market_uninstall(
    id: String,
    session: State<'_, EnterpriseSessionState>,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    market::uninstall(
        &session.0,
        &app_state.db,
        &MarketPaths::from_app_config(),
        &id,
    )
    .await
}

/// Zip a locally installed skill and publish it to the enterprise marketplace.
#[tauri::command]
pub async fn enterprise_market_publish_skill(
    skill_id: String,
    session: State<'_, EnterpriseSessionState>,
    app_state: State<'_, AppState>,
) -> Result<MarketItem, String> {
    market::publish_skill(&session.0, &app_state.db, &skill_id).await
}

//! Codex profile pushed from the enterprise admin console.
//!
//! One profile for every signed-in desktop. This module heartbeats, and when
//! the server revision or the live mode drifts, pulls the profile and applies
//! it through [`ProviderService`] and the mode controller. Managed cards use
//! the `fleet-` id prefix and are not enterprise-gateway cards.
//!
//! ponytail: polls every 30s. Upgrade path is an outbound SSE of the same
//! revision, still applied by this function.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use indexmap::IndexMap;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::client::{self, EnterpriseError};
use super::providers::{self, build_config_toml, SyncPlan};
use super::session::{self, EnterpriseSession};
use super::types::ManagedModel;
use crate::app_config::AppType;
use crate::provider::Provider;
use crate::services::ProviderService;
use crate::store::AppState;

const POLL_INTERVAL: Duration = Duration::from_secs(30);
const START_DELAY: Duration = Duration::from_secs(5);
const LOCAL_FILE: &str = "fleet-device.json";
pub(crate) const FLEET_ID_PREFIX: &str = "fleet-";

pub(crate) fn fleet_card_id(provider_id: &str) -> String {
    format!("{FLEET_ID_PREFIX}{provider_id}")
}

fn is_fleet(id: &str) -> bool {
    id.starts_with(FLEET_ID_PREFIX)
}

fn clip(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalDevice {
    device_id: String,
    #[serde(default)]
    applied_revision: i64,
    #[serde(default)]
    applied_profile_id: Option<String>,
    /// Returned once by the server. Never logged.
    #[serde(default)]
    device_secret: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FleetProviderSpec {
    #[serde(default = "direct_kind")]
    kind: String,
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    models: Vec<ManagedModel>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesiredFleet {
    revision: i64,
    profile_id: String,
    mode: String,
    active_provider_id: String,
    #[serde(default)]
    stack_member_ids: Vec<String>,
    #[serde(default)]
    providers: Vec<FleetProviderSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatResponse {
    desired_revision: i64,
    profile_id: String,
    mode: String,
    active_provider_id: String,
    #[serde(default)]
    stack_member_ids: Vec<String>,
    #[serde(default)]
    force_sync: bool,
    #[serde(default)]
    device_secret: Option<String>,
}

fn direct_kind() -> String {
    "direct".to_string()
}

fn managed_profile_id(card_id: &str) -> Option<&str> {
    card_id
        .strip_prefix(FLEET_ID_PREFIX)
        .or_else(|| card_id.strip_prefix("ccse-"))
}

fn card_id_for(spec: &FleetProviderSpec) -> String {
    if spec.kind == "gateway" {
        format!("ccse-{}", spec.id)
    } else {
        fleet_card_id(&spec.id)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportedProvider {
    id: String,
    name: String,
    managed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reported {
    mode: String,
    active_provider_id: Option<String>,
    active_provider_name: Option<String>,
    providers: Vec<ReportedProvider>,
    stack_member_ids: Vec<String>,
}

/// `true` when the live machine does not match the summary from the last heartbeat.
fn needs_apply(
    applied: i64,
    applied_profile: Option<&str>,
    live: &Reported,
    desired: &HeartbeatResponse,
) -> bool {
    if desired.force_sync {
        return true;
    }
    // An untouched default profile must not rewrite the machine.
    if desired.desired_revision == 0 && desired.active_provider_id.is_empty() {
        return false;
    }
    if applied_profile != Some(desired.profile_id.as_str()) || applied != desired.desired_revision
    {
        return true;
    }
    if desired.active_provider_id.is_empty() {
        return live.providers.iter().any(|p| p.id.starts_with(FLEET_ID_PREFIX));
    }
    if live.mode != desired.mode {
        return true;
    }
    let live_active = live
        .active_provider_id
        .as_deref()
        .and_then(managed_profile_id);
    if live_active != Some(desired.active_provider_id.as_str()) {
        return true;
    }
    let live_members: BTreeSet<&str> = live.stack_member_ids.iter().map(String::as_str).collect();
    if desired.mode == "stack" {
        let mut wanted = BTreeSet::new();
        wanted.insert(desired.active_provider_id.as_str());
        wanted.extend(desired.stack_member_ids.iter().map(String::as_str));
        live_members != wanted
    } else {
        !live_members.is_empty()
    }
}

fn catalog(spec: &FleetProviderSpec) -> Vec<Value> {
    let models = if spec.models.is_empty() {
        vec![ManagedModel {
            id: spec.model.clone(),
            display_name: spec.model.clone(),
        }]
    } else {
        spec.models.clone()
    };
    models
        .into_iter()
        .filter(|m| !m.id.trim().is_empty())
        .map(|m| {
            let name = if m.display_name.trim().is_empty() {
                m.id.clone()
            } else {
                m.display_name
            };
            json!({ "model": m.id.trim(), "displayName": name })
        })
        .collect()
}

fn desired_card(spec: &FleetProviderSpec, existing: Option<&Provider>, now_ms: i64) -> Provider {
    let name = if spec.name.trim().is_empty() {
        spec.id.clone()
    } else {
        spec.name.trim().to_string()
    };
    let model = spec.model.trim().to_string();
    let settings_config = json!({
        "auth": { "OPENAI_API_KEY": spec.api_key },
        "config": build_config_toml(&name, spec.base_url.trim(), &model),
        "modelCatalog": { "models": catalog(spec) },
    });
    let mut card = Provider::with_id(fleet_card_id(&spec.id), name, settings_config, None);
    card.category = Some("custom".into());
    match existing {
        Some(existing) => {
            card.created_at = existing.created_at;
            card.sort_index = existing.sort_index;
            card.icon = existing.icon.clone();
            card.icon_color = existing.icon_color.clone();
            card.in_failover_queue = existing.in_failover_queue;
        }
        None => card.created_at = Some(now_ms),
    }
    card
}

fn card_differs(existing: &Provider, desired: &Provider) -> bool {
    existing.name != desired.name
        || existing.category != desired.category
        || existing.settings_config != desired.settings_config
}

fn plan_fleet_cards(
    existing: &IndexMap<String, Provider>,
    desired: &[FleetProviderSpec],
    now_ms: i64,
) -> SyncPlan {
    let mut plan = SyncPlan::default();
    let mut wanted = std::collections::HashSet::new();
    for spec in desired {
        if spec.kind == "gateway" || spec.id.trim().is_empty() {
            continue;
        }
        let id = fleet_card_id(&spec.id);
        if !wanted.insert(id.clone()) {
            continue;
        }
        let current = existing.get(&id);
        let card = desired_card(spec, current, now_ms);
        match current {
            None => plan.create.push(card),
            Some(current) if card_differs(current, &card) => plan.update.push(card),
            Some(_) => {}
        }
    }
    plan.delete = existing
        .keys()
        .filter(|id| is_fleet(id) && !wanted.contains(*id))
        .cloned()
        .collect();
    plan
}

fn load_local(dir: &Path) -> Result<LocalDevice, String> {
    let path = dir.join(LOCAL_FILE);
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(local) = serde_json::from_str::<LocalDevice>(&text) {
            if uuid::Uuid::parse_str(&local.device_id).is_ok() {
                return Ok(local);
            }
        }
    }
    let local = LocalDevice {
        device_id: uuid::Uuid::new_v4().to_string(),
        applied_revision: 0,
        applied_profile_id: None,
        device_secret: None,
    };
    crate::config::write_json_file_private(&path, &local).map_err(|e| e.to_string())?;
    Ok(local)
}

fn save_local(dir: &Path, local: &LocalDevice) -> Result<(), String> {
    crate::config::write_json_file_private(&dir.join(LOCAL_FILE), local).map_err(|e| e.to_string())
}

fn app_state(app: &AppHandle) -> Result<tauri::State<'_, AppState>, String> {
    app.try_state::<AppState>()
        .ok_or_else(|| "App state unavailable".to_string())
}

fn collect_report(app: &AppHandle) -> Result<Reported, String> {
    let state = app_state(app)?;
    let providers =
        ProviderService::list(state.inner(), AppType::Codex).map_err(|e| e.to_string())?;
    let view = crate::mode::controller::app_mode_view(state.inner(), &AppType::Codex)?;
    let active_id = if view.mode == "direct" {
        view.direct_provider_id
    } else {
        view.route_provider_id
    };
    let active_name = active_id
        .as_ref()
        .and_then(|id| providers.get(id).map(|p| clip(&p.name, 100)));
    let stack = crate::mode::state::stack(
        &crate::live::engine::DeviceStore::for_device(),
        AppType::Codex.as_str(),
    )
    .map_err(|e| e.to_string())?;
    Ok(Reported {
        mode: view.mode.to_string(),
        active_provider_id: active_id.map(|id| clip(&id, 80)),
        active_provider_name: active_name,
        providers: providers
            .values()
            .take(200)
            .map(|p| ReportedProvider {
                id: clip(&p.id, 80),
                name: clip(&p.name, 100),
                managed: is_fleet(&p.id) || p.id.starts_with("ccse-"),
            })
            .collect(),
        stack_member_ids: stack
            .members
            .iter()
            .filter_map(|id| managed_profile_id(id).map(str::to_string))
            .take(50)
            .collect(),
    })
}

/// Create and update managed cards. Returns the ids that are no longer in the profile.
fn upsert_cards(app: &AppHandle, desired: &[FleetProviderSpec]) -> Result<Vec<String>, String> {
    let state = app_state(app)?;
    let existing =
        ProviderService::list(state.inner(), AppType::Codex).map_err(|e| e.to_string())?;
    let plan = plan_fleet_cards(&existing, desired, chrono::Utc::now().timestamp_millis());
    for card in plan.create {
        let id = card.id.clone();
        ProviderService::add_without_switching(state.inner(), AppType::Codex, card)
            .map_err(|e| format!("add {id}: {e}"))?;
    }
    for card in plan.update {
        let id = card.id.clone();
        ProviderService::update(state.inner(), AppType::Codex, None, card)
            .map_err(|e| format!("update {id}: {e}"))?;
    }
    Ok(plan.delete)
}

fn delete_cards(app: &AppHandle, ids: &[String]) -> Result<(), String> {
    let state = app_state(app)?;
    for id in ids {
        ProviderService::delete(state.inner(), AppType::Codex, id)
            .map_err(|e| format!("delete {id}: {e}"))?;
    }
    Ok(())
}

fn switch_to(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app_state(app)?;
    ProviderService::switch(state.inner(), AppType::Codex, id).map_err(|e| e.to_string())?;
    Ok(())
}

fn fallback_id(existing: &IndexMap<String, Provider>) -> Option<String> {
    existing
        .values()
        .find(|p| !is_fleet(&p.id) && p.category.as_deref() == Some("official"))
        .or_else(|| existing.values().find(|p| !is_fleet(&p.id)))
        .map(|p| p.id.clone())
}

struct ClearPlan {
    fleet_ids: Vec<String>,
    /// Leave proxy first so a following switch rewrites the direct pointer.
    exit_proxy: bool,
    /// Switch to this local provider after exit. `None` when the direct pointer is already local.
    switch_to: Option<String>,
    /// Saved route still names a managed card; point it at the direct provider.
    retarget_route: bool,
}

fn plan_clear(app: &AppHandle) -> Result<ClearPlan, String> {
    let state = app_state(app)?;
    let existing =
        ProviderService::list(state.inner(), AppType::Codex).map_err(|e| e.to_string())?;
    let fleet_ids: Vec<String> = existing.keys().filter(|id| is_fleet(id)).cloned().collect();
    let view = crate::mode::controller::app_mode_view(state.inner(), &AppType::Codex)?;
    let direct_fleet = view
        .direct_provider_id
        .as_ref()
        .is_some_and(|id| is_fleet(id));
    let route_fleet = view
        .route_provider_id
        .as_ref()
        .is_some_and(|id| is_fleet(id));
    if fleet_ids.is_empty() {
        return Ok(ClearPlan {
            fleet_ids,
            exit_proxy: false,
            switch_to: None,
            retarget_route: false,
        });
    }
    if direct_fleet && fallback_id(&existing).is_none() {
        return Err("远程供应商正在使用，且没有可退回的本地供应商".to_string());
    }
    Ok(ClearPlan {
        fleet_ids,
        exit_proxy: view.mode != "direct",
        switch_to: direct_fleet.then(|| fallback_id(&existing)).flatten(),
        retarget_route: route_fleet,
    })
}

async fn clear_fleet(app: &AppHandle) -> Result<(), String> {
    let plan = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || plan_clear(&app))
            .await
            .map_err(|e| e.to_string())??
    };
    if plan.fleet_ids.is_empty() {
        return Ok(());
    }
    if plan.exit_proxy {
        let state = app.state::<AppState>();
        crate::mode::controller::exit(state.inner(), &AppType::Codex).await?;
    }
    if let Some(id) = plan.switch_to.clone() {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || switch_to(&app, &id))
            .await
            .map_err(|e| e.to_string())??;
    }
    if plan.retarget_route {
        let state = app.state::<AppState>();
        let view = crate::mode::controller::app_mode_view(state.inner(), &AppType::Codex)?;
        if let Some(direct) = view.direct_provider_id.as_deref() {
            if !is_fleet(direct) {
                crate::mode::controller::set_route(state.inner(), &AppType::Codex, direct).await?;
            }
        }
    }
    let ids = plan.fleet_ids;
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || delete_cards(&app, &ids))
        .await
        .map_err(|e| e.to_string())??;
    Ok(())
}

async fn apply_membership(app: &AppHandle, desired: &DesiredFleet) -> Result<(), String> {
    let wanted: BTreeSet<&str> = if desired.mode == "stack" {
        let mut set = BTreeSet::new();
        set.insert(desired.active_provider_id.as_str());
        set.extend(desired.stack_member_ids.iter().map(String::as_str));
        set
    } else {
        BTreeSet::new()
    };
    let state = app.state::<AppState>();
    for spec in &desired.providers {
        let card_id = card_id_for(spec);
        let enabled = wanted.contains(spec.id.as_str());
        let current =
            crate::mode::stack::is_member(&AppType::Codex, &card_id).map_err(|e| e.to_string())?;
        if current == enabled {
            continue;
        }
        crate::mode::controller::set_stack_member(
            state.inner(),
            &AppType::Codex,
            &card_id,
            enabled,
        )
        .await
        .map_err(|e| e.message)?;
    }
    Ok(())
}

async fn apply_mode(app: &AppHandle, desired: &DesiredFleet) -> Result<(), String> {
    let active = desired
        .providers
        .iter()
        .find(|spec| spec.id == desired.active_provider_id)
        .map(card_id_for)
        .unwrap_or_else(|| fleet_card_id(&desired.active_provider_id));
    match desired.mode.as_str() {
        "direct" => {
            let proxy = {
                let state = app.state::<AppState>();
                crate::mode::controller::app_mode_view(state.inner(), &AppType::Codex)?.mode
                    != "direct"
            };
            if proxy {
                let state = app.state::<AppState>();
                crate::mode::controller::exit(state.inner(), &AppType::Codex).await?;
            }
            let app = app.clone();
            let active = active.clone();
            tauri::async_runtime::spawn_blocking(move || switch_to(&app, &active))
                .await
                .map_err(|e| e.to_string())??;
        }
        "route" => {
            let state = app.state::<AppState>();
            crate::mode::controller::enter_with_route(
                state.inner(),
                &AppType::Codex,
                false,
                Some(&active),
            )
            .await?;
        }
        "stack" => {
            let state = app.state::<AppState>();
            crate::mode::controller::enter_with_route(
                state.inner(),
                &AppType::Codex,
                true,
                Some(&active),
            )
            .await?;
        }
        other => return Err(format!("unknown fleet mode {other}")),
    }
    apply_membership(app, desired).await
}

async fn apply_desired(app: &AppHandle, desired: &DesiredFleet) -> Result<(), String> {
    let _guard = providers::SYNC_LOCK.lock().await;
    if desired.providers.is_empty() {
        clear_fleet(app).await?;
    } else {
        let specs = desired.providers.clone();
        let app_for_upsert = app.clone();
        let delete_ids =
            tauri::async_runtime::spawn_blocking(move || upsert_cards(&app_for_upsert, &specs))
                .await
                .map_err(|e| e.to_string())??;
        apply_mode(app, desired).await?;
        let app_for_delete = app.clone();
        tauri::async_runtime::spawn_blocking(move || delete_cards(&app_for_delete, &delete_ids))
            .await
            .map_err(|e| e.to_string())??;
    }
    if let Err(e) = app.emit("universal-provider-synced", json!({ "source": "fleet" })) {
        log::warn!("[Fleet] failed to emit providers changed: {e}");
    }
    crate::tray::refresh_tray_menu(app);
    Ok(())
}

async fn post_json<B: Serialize, T: DeserializeOwned>(
    session: &EnterpriseSession,
    path: &str,
    body: &B,
) -> Result<T, EnterpriseError> {
    let (_, resp) = session
        .send_authenticated(|http, base, token| {
            http.post(client::endpoint(base, path))
                .bearer_auth(token)
                .json(body)
        })
        .await?;
    client::decode_json(resp).await
}

async fn post_applied(
    session: &EnterpriseSession,
    device_id: &str,
    device_secret: &str,
    profile_id: &str,
    revision: i64,
    error: Option<&str>,
) -> Result<(), EnterpriseError> {
    let (_, resp) = session
        .send_authenticated(|http, base, token| {
            http.post(client::endpoint(base, "/devices/me/applied"))
                .bearer_auth(token)
                .json(&json!({
                    "deviceId": device_id,
                    "deviceSecret": device_secret,
                    "profileId": profile_id,
                    "revision": revision,
                    "error": error,
                }))
        })
        .await?;
    let _ = resp.bytes().await;
    Ok(())
}

async fn sync_once(app: &AppHandle, session: &EnterpriseSession, dir: &Path) -> Result<(), String> {
    let state = session.state().await;
    if !state.logged_in {
        return Ok(());
    }
    let mut local = load_local(dir)?;
    let reported = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || collect_report(&app))
            .await
            .map_err(|e| e.to_string())??
    };
    let hostname = session::hostname().unwrap_or_default();
    let mut heartbeat = json!({
        "deviceId": local.device_id,
        "name": session::device_name(),
        "hostname": clip(&hostname, 100),
        "reported": reported,
    });
    if let Some(secret) = &local.device_secret {
        heartbeat["deviceSecret"] = json!(secret);
    }
    let summary: HeartbeatResponse = post_json(session, "/devices/heartbeat", &heartbeat)
    .await
    .map_err(|e| e.to_string())?;
    if let Some(secret) = summary.device_secret.clone() {
        local.device_secret = Some(secret);
        save_local(dir, &local)?;
    }
    if let Some(secret) = local.device_secret.clone() {
        session
            .set_device_binding(local.device_id.clone(), secret)
            .await;
        // Re-issue the gateway key for this device and refresh the ccse- cards.
        providers::run_sync(app, session).await;
    }

    let can_apply = state
        .permissions
        .iter()
        .any(|p| p == session::MODELS_USE_PERMISSION);
    if !can_apply
        || !needs_apply(
            local.applied_revision,
            local.applied_profile_id.as_deref(),
            &reported,
            &summary,
        )
    {
        return Ok(());
    }
    let Some(secret) = local.device_secret.clone() else {
        return Err("device secret missing".to_string());
    };

    let path = format!("/devices/me/desired?deviceId={}", local.device_id);
    let (_, resp) = session
        .send_authenticated(|http, base, token| {
            http.get(client::endpoint(base, &path))
                .bearer_auth(token)
                .header("x-device-secret", &secret)
        })
        .await
        .map_err(|e| e.to_string())?;
    let desired: DesiredFleet = client::decode_json(resp).await.map_err(|e| e.to_string())?;
    match apply_desired(app, &desired).await {
        Ok(()) => {
            post_applied(
                session,
                &local.device_id,
                &secret,
                &desired.profile_id,
                desired.revision,
                None,
            )
            .await
            .map_err(|e| e.to_string())?;
            local.applied_revision = desired.revision;
            local.applied_profile_id = Some(desired.profile_id.clone());
            save_local(dir, &local)?;
            log::info!(
                "[Fleet] applied profile {} revision {}",
                desired.profile_id,
                desired.revision
            );
            Ok(())
        }
        Err(error) => {
            let error = clip(&error, 500);
            log::warn!("[Fleet] apply failed: {error}");
            let _ = post_applied(
                session,
                &local.device_id,
                &secret,
                &desired.profile_id,
                desired.revision,
                Some(&error),
            )
            .await;
            Ok(())
        }
    }
}

/// ponytail: usage is uploaded on the same 30s loop, at most every 10 minutes.
const USAGE_INTERVAL: Duration = Duration::from_secs(600);

async fn upload_usage(
    session: &EnterpriseSession,
    dir: &Path,
    local: &LocalDevice,
) -> Result<(), String> {
    let Some(secret) = local.device_secret.clone() else {
        return Ok(());
    };
    let db_path = dir.join("cc-switch.db");
    let device_id = local.device_id.clone();
    let items = tauri::async_runtime::spawn_blocking(move || read_rollups(&db_path))
        .await
        .map_err(|e| e.to_string())??;
    if items.is_empty() {
        return Ok(());
    }
    let (_, resp) = session
        .send_authenticated(|http, base, token| {
            http.post(client::endpoint(base, "/devices/me/usage"))
                .bearer_auth(token)
                .json(&json!({
                    "deviceId": device_id,
                    "deviceSecret": secret,
                    "items": items,
                }))
        })
        .await
        .map_err(|e| e.to_string())?;
    let _ = resp.bytes().await;
    Ok(())
}

fn read_rollups(db_path: &Path) -> Result<Vec<serde_json::Value>, String> {
    if !db_path.exists() {
        return Ok(Vec::new());
    }
    let conn = rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let since = (chrono::Utc::now() - chrono::Duration::days(7))
        .format("%Y-%m-%d")
        .to_string();
    let mut stmt = conn
        .prepare(
            "SELECT date, provider_id, model,
                    SUM(request_count), SUM(input_tokens), SUM(output_tokens),
                    SUM(CAST(total_cost_usd AS REAL))
             FROM usage_daily_rollups
             WHERE app_type = 'codex' AND date >= ?1
             GROUP BY date, provider_id, model",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&since], |row| {
            Ok(json!({
                "date": row.get::<_, String>(0)?,
                "providerId": row.get::<_, String>(1)?,
                "model": row.get::<_, String>(2)?,
                "requests": row.get::<_, i64>(3)?,
                "inputTokens": row.get::<_, i64>(4)?,
                "outputTokens": row.get::<_, i64>(5)?,
                "costUsd": row.get::<_, f64>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn install(app: &AppHandle, session: &Arc<EnterpriseSession>) {
    let app = app.clone();
    let session = session.clone();
    let dir: PathBuf = crate::config::get_app_config_dir();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(START_DELAY).await;
        let mut last_usage = tokio::time::Instant::now() - USAGE_INTERVAL;
        loop {
            if let Err(e) = sync_once(&app, &session, &dir).await {
                log::warn!("[Fleet] {e}");
            }
            if last_usage.elapsed() >= USAGE_INTERVAL {
                let local = load_local(&dir);
                match local {
                    Ok(local) => {
                        if let Err(e) = upload_usage(&session, &dir, &local).await {
                            log::warn!("[Fleet] usage upload failed: {e}");
                        }
                    }
                    Err(e) => log::warn!("[Fleet] {e}"),
                }
                last_usage = tokio::time::Instant::now();
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::Provider;

    fn spec(id: &str, key: &str, model: &str) -> FleetProviderSpec {
        FleetProviderSpec {
            kind: "direct".into(),
            id: id.into(),
            name: format!("Name {id}"),
            base_url: "https://example.com/v1".into(),
            api_key: key.into(),
            model: model.into(),
            models: vec![],
        }
    }

    fn reported(mode: &str, active: Option<&str>, members: &[&str], managed: bool) -> Reported {
        Reported {
            mode: mode.into(),
            active_provider_id: active.map(str::to_string),
            active_provider_name: None,
            providers: vec![ReportedProvider {
                id: "fleet-volcengine".into(),
                name: "火山".into(),
                managed,
            }],
            stack_member_ids: members.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    fn summary(revision: i64, mode: &str, active: &str, members: &[&str]) -> HeartbeatResponse {
        HeartbeatResponse {
            desired_revision: revision,
            profile_id: "profile".into(),
            mode: mode.into(),
            active_provider_id: active.into(),
            stack_member_ids: members.iter().map(|s| (*s).to_string()).collect(),
            force_sync: false,
            device_secret: None,
        }
    }

    #[test]
    fn plan_creates_updates_and_deletes_only_fleet_cards() {
        let mut existing = IndexMap::new();
        let kept = desired_card(&spec("volcengine", "sk-old", "m1"), None, 1);
        existing.insert(kept.id.clone(), kept);
        let mut local =
            Provider::with_id("codex-official".into(), "default".into(), json!({}), None);
        local.category = Some("official".into());
        existing.insert(local.id.clone(), local);

        let mut changed = spec("volcengine", "sk-new", "m1");
        changed.name = "火山".into();
        let plan = plan_fleet_cards(&existing, &[changed, spec("yida", "sk-y", "gpt-5.5")], 10);
        assert_eq!(plan.create.len(), 1);
        assert_eq!(plan.create[0].id, "fleet-yida");
        assert_eq!(plan.update.len(), 1);
        assert_eq!(plan.update[0].id, "fleet-volcengine");
        assert_eq!(
            plan.update[0].settings_config["auth"]["OPENAI_API_KEY"],
            "sk-new"
        );
        assert!(plan.delete.is_empty());

        let plan = plan_fleet_cards(&existing, &[], 10);
        assert_eq!(plan.delete, vec!["fleet-volcengine".to_string()]);
        assert!(plan.create.is_empty());
    }

    #[test]
    fn needs_apply_follows_revision_and_live_drift() {
        let live = reported("direct", Some("fleet-volcengine"), &[], true);
        let profile = Some("profile");
        assert!(!needs_apply(
            0,
            profile,
            &live,
            &summary(0, "direct", "", &[])
        ));
        assert!(needs_apply(
            0,
            profile,
            &live,
            &summary(2, "stack", "volcengine", &["yida"])
        ));
        assert!(!needs_apply(
            2,
            profile,
            &live,
            &summary(2, "direct", "volcengine", &[]),
        ));
        let switched = reported("direct", Some("codex-official"), &[], true);
        assert!(needs_apply(
            2,
            profile,
            &switched,
            &summary(2, "direct", "volcengine", &[]),
        ));
        let extra = reported(
            "stack",
            Some("fleet-volcengine"),
            &["volcengine", "yida"],
            true,
        );
        assert!(needs_apply(
            2,
            profile,
            &extra,
            &summary(2, "stack", "volcengine", &[]),
        ));
        assert!(needs_apply(
            2,
            profile,
            &live,
            &summary(2, "direct", "", &[])
        ));
        assert!(needs_apply(
            2,
            Some("other"),
            &live,
            &summary(2, "direct", "volcengine", &[])
        ));
    }
}

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
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FleetProviderSpec {
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
    mode: String,
    active_provider_id: String,
    #[serde(default)]
    stack_member_ids: Vec<String>,
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
fn needs_apply(applied: i64, live: &Reported, desired: &HeartbeatResponse) -> bool {
    if desired.desired_revision == 0 {
        return false;
    }
    if applied != desired.desired_revision {
        return true;
    }
    if desired.active_provider_id.is_empty() {
        return live.providers.iter().any(|p| p.managed);
    }
    if live.mode != desired.mode {
        return true;
    }
    let live_active = live
        .active_provider_id
        .as_deref()
        .and_then(|id| id.strip_prefix(FLEET_ID_PREFIX));
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
        if spec.id.trim().is_empty() {
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
                managed: is_fleet(&p.id),
            })
            .collect(),
        stack_member_ids: stack
            .members
            .iter()
            .filter_map(|id| id.strip_prefix(FLEET_ID_PREFIX).map(str::to_string))
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
        let card_id = fleet_card_id(&spec.id);
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
    let active = fleet_card_id(&desired.active_provider_id);
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
    revision: i64,
    error: Option<&str>,
) -> Result<(), EnterpriseError> {
    let (_, resp) = session
        .send_authenticated(|http, base, token| {
            http.post(client::endpoint(base, "/devices/me/applied"))
                .bearer_auth(token)
                .json(&json!({
                    "deviceId": device_id,
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
    let summary: HeartbeatResponse = post_json(
        session,
        "/devices/heartbeat",
        &json!({
            "deviceId": local.device_id,
            "name": session::device_name(),
            "hostname": clip(&hostname, 100),
            "reported": reported,
        }),
    )
    .await
    .map_err(|e| e.to_string())?;

    let can_apply = state
        .permissions
        .iter()
        .any(|p| p == session::MODELS_USE_PERMISSION);
    if !can_apply || !needs_apply(local.applied_revision, &reported, &summary) {
        return Ok(());
    }

    let path = format!("/devices/me/desired?deviceId={}", local.device_id);
    let desired: DesiredFleet = session.get_json(&path).await.map_err(|e| e.to_string())?;
    match apply_desired(app, &desired).await {
        Ok(()) => {
            post_applied(session, &local.device_id, desired.revision, None)
                .await
                .map_err(|e| e.to_string())?;
            local.applied_revision = desired.revision;
            save_local(dir, &local)?;
            log::info!("[Fleet] applied revision {}", desired.revision);
            Ok(())
        }
        Err(error) => {
            let error = clip(&error, 500);
            log::warn!("[Fleet] apply failed: {error}");
            let _ = post_applied(
                session,
                &local.device_id,
                desired.revision,
                Some(&error),
            )
            .await;
            Ok(())
        }
    }
}

pub fn install(app: &AppHandle, session: &Arc<EnterpriseSession>) {
    let app = app.clone();
    let session = session.clone();
    let dir: PathBuf = crate::config::get_app_config_dir();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(START_DELAY).await;
        loop {
            if let Err(e) = sync_once(&app, &session, &dir).await {
                log::warn!("[Fleet] {e}");
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
            mode: mode.into(),
            active_provider_id: active.into(),
            stack_member_ids: members.iter().map(|s| (*s).to_string()).collect(),
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
        assert!(!needs_apply(0, &live, &summary(0, "direct", "", &[])));
        assert!(needs_apply(
            0,
            &live,
            &summary(2, "stack", "volcengine", &["yida"])
        ));
        assert!(!needs_apply(
            2,
            &live,
            &summary(2, "direct", "volcengine", &[]),
        ));
        let switched = reported("direct", Some("codex-official"), &[], true);
        assert!(needs_apply(
            2,
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
            &extra,
            &summary(2, "stack", "volcengine", &[]),
        ));
        assert!(needs_apply(2, &live, &summary(2, "direct", "", &[])));
    }
}

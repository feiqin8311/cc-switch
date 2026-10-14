//! Enterprise-managed Codex providers.
//!
//! After every successful login / config fetch the managed providers offered by
//! the enterprise server (`GET /client/config` → `providers`) are mirrored into
//! the Codex providers table as read-only cards (`meta.enterprise`). Each card
//! talks to the server's gateway (`<serverUrl><gatewayPath>`, OpenAI Responses
//! API) with the gateway key of the current login session as `OPENAI_API_KEY`.
//! Logging out (or losing the session) removes the cards again.
//!
//! The planning part ([`plan_sync`], [`build_config_toml`], [`apply_model_change`])
//! is pure; [`run_sync`] applies a plan through the regular `ProviderService`
//! paths, which re-apply the live Codex config when the current card changes.

use std::sync::{Arc, Weak};
use std::time::Duration;

use indexmap::IndexMap;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use toml_edit::{value, DocumentMut};

use super::client::EnterpriseError;
use super::session::{EnterpriseSession, SessionEvent};
use super::types::{EnterpriseProviderMeta, ManagedModel, ManagedProvider};
use crate::app_config::AppType;
use crate::error::AppError;
use crate::provider::Provider;
use crate::services::ProviderService;
use crate::store::AppState;

/// Card ids are `ccse-<managed provider id>`.
pub const MANAGED_ID_PREFIX: &str = "ccse-";
/// Category the third-party / custom Codex cards use.
const MANAGED_CATEGORY: &str = "custom";
const STARTUP_SYNC_DELAY: Duration = Duration::from_secs(3);
/// Same event the universal-provider sync uses: the UI refetches providers + tray.
const PROVIDERS_CHANGED_EVENT: &str = "universal-provider-synced";

/// Serializes syncs and model changes so they never interleave.
pub(crate) static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// What the managed cards should look like: `None` = no managed cards at all.
pub(crate) struct DesiredGateway<'a> {
    pub server_url: &'a str,
    pub gateway_key: &'a str,
    pub providers: &'a [ManagedProvider],
}

/// Changes to apply to the Codex providers table.
#[derive(Debug, Default)]
pub(crate) struct SyncPlan {
    pub create: Vec<Provider>,
    pub update: Vec<Provider>,
    pub delete: Vec<String>,
}

impl SyncPlan {
    pub fn is_empty(&self) -> bool {
        self.create.is_empty() && self.update.is_empty() && self.delete.is_empty()
    }
}

pub(crate) fn managed_card_id(provider_id: &str) -> String {
    format!("{MANAGED_ID_PREFIX}{provider_id}")
}

pub(crate) fn enterprise_meta(provider: &Provider) -> Option<&EnterpriseProviderMeta> {
    provider.meta.as_ref().and_then(|m| m.enterprise.as_ref())
}

/// `<serverUrl><gatewayPath>`; falls back to `/gateway/<id>/v1` when the server
/// sent no path.
pub(crate) fn gateway_base_url(server_url: &str, provider: &ManagedProvider) -> String {
    let server = server_url.trim_end_matches('/');
    let path = provider.gateway_path.trim();
    if path.is_empty() {
        return format!("{server}/gateway/{}/v1", provider.id);
    }
    if path.starts_with('/') {
        format!("{server}{path}")
    } else {
        format!("{server}/{path}")
    }
}

/// The models offered for a managed provider (display name defaults to the id).
fn offered_models(provider: &ManagedProvider) -> Vec<ManagedModel> {
    let mut models: Vec<ManagedModel> = provider
        .models
        .iter()
        .filter(|m| !m.id.trim().is_empty())
        .map(|m| ManagedModel {
            id: m.id.trim().to_string(),
            display_name: if m.display_name.trim().is_empty() {
                m.id.trim().to_string()
            } else {
                m.display_name.trim().to_string()
            },
        })
        .collect();
    let default = provider.default_model.trim();
    if models.is_empty() && !default.is_empty() {
        models.push(ManagedModel {
            id: default.to_string(),
            display_name: default.to_string(),
        });
    }
    models
}

/// Keep `current` when it is still offered, else the default model, else the first one.
fn choose_model(
    current: Option<&str>,
    provider: &ManagedProvider,
    models: &[ManagedModel],
) -> String {
    let offered = |id: &str| models.iter().any(|m| m.id == id);
    if let Some(current) = current.map(str::trim).filter(|c| !c.is_empty()) {
        if offered(current) {
            return current.to_string();
        }
    }
    let default = provider.default_model.trim();
    if !default.is_empty() && (models.is_empty() || offered(default)) {
        return default.to_string();
    }
    models
        .first()
        .map(|m| m.id.clone())
        .unwrap_or_else(|| default.to_string())
}

/// Third-party Codex `config.toml` (same shape as the frontend's
/// `generateThirdPartyConfig`).
pub(crate) fn build_config_toml(provider_name: &str, base_url: &str, model: &str) -> String {
    let mut doc = DocumentMut::new();
    doc["model_provider"] = value("custom");
    doc["model"] = value(model);
    doc["model_reasoning_effort"] = value("high");
    doc["disable_response_storage"] = value(true);
    let mut custom = toml_edit::Table::new();
    custom["name"] = value(provider_name);
    custom["base_url"] = value(base_url);
    custom["wire_api"] = value("responses");
    custom["requires_openai_auth"] = value(true);
    let mut providers = toml_edit::Table::new();
    providers.set_implicit(true);
    providers.insert("custom", toml_edit::Item::Table(custom));
    doc["model_providers"] = toml_edit::Item::Table(providers);
    doc.to_string()
}

/// Top-level `model` of a Codex config, if any.
pub(crate) fn config_model(config_text: &str) -> Option<String> {
    let doc = config_text.parse::<DocumentMut>().ok()?;
    doc.get("model")
        .and_then(|item| item.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Replace the top-level `model` keeping the rest of the document (formatting,
/// comments) as is.
pub(crate) fn set_config_model(config_text: &str, model: &str) -> Result<String, String> {
    let mut doc = config_text
        .parse::<DocumentMut>()
        .map_err(|e| format!("Invalid Codex config.toml: {e}"))?;
    match doc.get_mut("model") {
        Some(item) if item.is_value() => {
            // Keep the key's decoration (comments / spacing) around the value.
            let decor = item.as_value().map(|v| v.decor().clone());
            *item = value(model);
            if let (Some(decor), Some(v)) = (decor, item.as_value_mut()) {
                *v.decor_mut() = decor;
            }
        }
        _ => {
            doc["model"] = value(model);
        }
    }
    Ok(doc.to_string())
}

fn settings_config_text(provider: &Provider) -> &str {
    provider
        .settings_config
        .get("config")
        .and_then(Value::as_str)
        .unwrap_or("")
}

/// The card a managed provider should be, keeping the user's model choice and
/// the local-only fields (sort order, failover queue, icon, other meta) of
/// `existing`.
fn desired_card(
    gateway: &DesiredGateway<'_>,
    managed: &ManagedProvider,
    existing: Option<&Provider>,
    now_ms: i64,
) -> Provider {
    let models = offered_models(managed);
    let current_model = existing.and_then(|p| config_model(settings_config_text(p)));
    let model = choose_model(current_model.as_deref(), managed, &models);
    let name = if managed.name.trim().is_empty() {
        managed.id.clone()
    } else {
        managed.name.trim().to_string()
    };
    let base_url = gateway_base_url(gateway.server_url, managed);
    let catalog: Vec<Value> = models
        .iter()
        .map(|m| json!({ "model": m.id, "displayName": m.display_name }))
        .collect();
    let settings_config = json!({
        "auth": { "OPENAI_API_KEY": gateway.gateway_key },
        "config": build_config_toml(&name, &base_url, &model),
        "modelCatalog": { "models": catalog },
    });

    let mut meta = existing.and_then(|p| p.meta.clone()).unwrap_or_default();
    meta.enterprise = Some(EnterpriseProviderMeta {
        server_url: gateway.server_url.to_string(),
        provider_id: managed.id.clone(),
        models,
    });

    let mut card = Provider::with_id(managed_card_id(&managed.id), name, settings_config, None);
    card.category = Some(MANAGED_CATEGORY.to_string());
    card.meta = Some(meta);
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
        || enterprise_meta(existing) != enterprise_meta(desired)
}

/// Diff the Codex providers table against what the server offers.
pub(crate) fn plan_sync(
    existing: &IndexMap<String, Provider>,
    desired: Option<&DesiredGateway<'_>>,
    now_ms: i64,
) -> SyncPlan {
    let mut plan = SyncPlan::default();
    let mut wanted = std::collections::HashSet::new();

    if let Some(gateway) = desired {
        for managed in gateway.providers {
            if managed.id.trim().is_empty() {
                continue;
            }
            let id = managed_card_id(&managed.id);
            if !wanted.insert(id.clone()) {
                continue; // duplicate id from the server
            }
            let current = existing.get(&id);
            let card = desired_card(gateway, managed, current, now_ms);
            match current {
                None => plan.create.push(card),
                Some(current) if card_differs(current, &card) => plan.update.push(card),
                Some(_) => {}
            }
        }
    }

    plan.delete = existing
        .values()
        .filter(|p| enterprise_meta(p).is_some() && !wanted.contains(&p.id))
        .map(|p| p.id.clone())
        .collect();
    plan
}

/// The provider with its `model` set to `model`, or `None` when it already is.
/// Enterprise cards only accept the managed models; cards with a model catalog
/// only accept catalog models.
pub(crate) fn apply_model_change(
    provider: &Provider,
    model: &str,
) -> Result<Option<Provider>, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("Model must not be empty".to_string());
    }
    if let Some(meta) = enterprise_meta(provider) {
        if !meta.models.iter().any(|m| m.id == model) {
            return Err(format!(
                "Model '{model}' is not offered by the enterprise provider"
            ));
        }
    } else {
        let catalog = catalog_models(&provider.settings_config);
        if !catalog.is_empty() && !catalog.iter().any(|m| m == model) {
            return Err(format!(
                "Model '{model}' is not in this provider's model catalog"
            ));
        }
    }

    let config_text = settings_config_text(provider);
    if config_model(config_text).as_deref() == Some(model) {
        return Ok(None);
    }
    let updated = set_config_model(config_text, model)?;
    let mut next = provider.clone();
    match next.settings_config.as_object_mut() {
        Some(obj) => {
            obj.insert("config".to_string(), Value::String(updated));
        }
        None => return Err("Provider settings are not an object".to_string()),
    }
    Ok(Some(next))
}

/// Model ids of `settings_config.modelCatalog.models` (the shape the editor saves).
fn catalog_models(settings: &Value) -> Vec<String> {
    settings
        .get("modelCatalog")
        .and_then(|c| c.get("models"))
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|m| m.get("model").and_then(Value::as_str))
                .map(|m| m.trim().to_string())
                .filter(|m| !m.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/// Hook the managed-provider sync into the session and run one sync shortly
/// after startup (cleans up cards of an expired session, re-applies cached ones).
pub fn install(app: &AppHandle, session: &Arc<EnterpriseSession>) {
    let weak: Weak<EnterpriseSession> = Arc::downgrade(session);
    let handle = app.clone();
    session.set_listener(Arc::new(move |event: SessionEvent| {
        let Some(session) = weak.upgrade() else {
            return;
        };
        let app = handle.clone();
        tauri::async_runtime::spawn(async move {
            log::debug!("[Enterprise] session event {event:?}, syncing managed providers");
            run_sync(&app, &session).await;
        });
    }));

    let app = app.clone();
    let weak = Arc::downgrade(session);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_SYNC_DELAY).await;
        if let Some(session) = weak.upgrade() {
            run_sync(&app, &session).await;
        }
    });
}

/// Bring the managed Codex cards in line with the session. Failures are logged
/// only; the cards are left as they are when the gateway key is unavailable.
pub async fn run_sync(app: &AppHandle, session: &EnterpriseSession) {
    let _guard = SYNC_LOCK.lock().await;

    let snapshot = session.managed_providers_snapshot().await;
    let desired = match snapshot {
        Some(snapshot) if snapshot.wants_gateway() => match session.ensure_gateway_key().await {
            Ok((base, key)) if base == snapshot.server_url => Some((snapshot, key)),
            Ok(_) | Err(EnterpriseError::NotLoggedIn) => {
                // The session changed meanwhile; its own event triggers another sync.
                return;
            }
            Err(e) => {
                log::warn!(
                    "[Enterprise] managed providers not synced, gateway key unavailable: {e}"
                );
                return;
            }
        },
        _ => None,
    };

    let app_for_task = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app_for_task
            .try_state::<AppState>()
            .ok_or_else(|| AppError::Message("App state unavailable".to_string()))?;
        let gateway = desired.as_ref().map(|(snapshot, key)| DesiredGateway {
            server_url: &snapshot.server_url,
            gateway_key: key,
            providers: &snapshot.providers,
        });
        apply_sync(state.inner(), gateway.as_ref())
    })
    .await;

    match result {
        Ok(Ok(true)) => {
            if let Err(e) = app.emit(PROVIDERS_CHANGED_EVENT, json!({ "source": "enterprise" })) {
                log::warn!("[Enterprise] failed to emit providers changed event: {e}");
            }
            crate::tray::refresh_tray_menu(app);
        }
        Ok(Ok(false)) => {}
        Ok(Err(e)) => log::error!("[Enterprise] managed provider sync failed: {e}"),
        Err(e) => log::error!("[Enterprise] managed provider sync task failed: {e}"),
    }
}

/// Apply the sync plan. Per-card failures are logged and skipped. Returns
/// whether anything changed.
pub(super) fn apply_sync(
    state: &AppState,
    desired: Option<&DesiredGateway<'_>>,
) -> Result<bool, AppError> {
    let existing = ProviderService::list(state, AppType::Codex)?;
    let plan = plan_sync(&existing, desired, chrono::Utc::now().timestamp_millis());
    if plan.is_empty() {
        return Ok(false);
    }
    let mut changed = false;
    let mut failures = 0usize;

    for card in plan.create {
        let id = card.id.clone();
        match ProviderService::add_without_switching(state, AppType::Codex, card) {
            Ok(_) => {
                changed = true;
                log::info!("[Enterprise] added managed Codex provider {id}");
            }
            Err(e) => {
                failures += 1;
                log::error!("[Enterprise] failed to add managed Codex provider {id}: {e}");
            }
        }
    }
    for card in plan.update {
        let id = card.id.clone();
        // Re-applies the live Codex config when this card is in use.
        match ProviderService::update(state, AppType::Codex, None, card) {
            Ok(_) => {
                changed = true;
                log::info!("[Enterprise] updated managed Codex provider {id}");
            }
            Err(e) => {
                failures += 1;
                log::error!("[Enterprise] failed to update managed Codex provider {id}: {e}");
            }
        }
    }
    for id in plan.delete {
        let result = match crate::mode::current::is_referenced(&state.db, &AppType::Codex, &id) {
            Ok(true) => {
                log::warn!(
                    "[Enterprise] removing managed Codex provider {id} although it is in use"
                );
                state.db.delete_provider(AppType::Codex.as_str(), &id)
            }
            Ok(false) => ProviderService::delete(state, AppType::Codex, &id),
            Err(e) => Err(e),
        };
        match result {
            Ok(()) => {
                changed = true;
                log::info!("[Enterprise] removed managed Codex provider {id}");
            }
            Err(e) => {
                failures += 1;
                log::error!("[Enterprise] failed to remove managed Codex provider {id}: {e}");
            }
        }
    }
    if failures > 0 {
        log::warn!("[Enterprise] managed provider sync finished with {failures} failure(s)");
    }
    Ok(changed)
}

/// Set the `model` of a Codex provider card (re-applies the live config when
/// the card is in use). Returns whether anything changed.
pub async fn set_provider_model(
    app: &AppHandle,
    provider_id: String,
    model: String,
) -> Result<bool, String> {
    let _guard = SYNC_LOCK.lock().await;
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<AppState>()
            .ok_or_else(|| "App state unavailable".to_string())?;
        let provider = state
            .db
            .get_provider_by_id(&provider_id, AppType::Codex.as_str())
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Codex provider '{provider_id}' not found"))?;
        let Some(next) = apply_model_change(&provider, &model)? else {
            return Ok(false);
        };
        ProviderService::update(state.inner(), AppType::Codex, None, next)
            .map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("Model change task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderMeta;

    fn managed(id: &str, models: &[&str], default: &str) -> ManagedProvider {
        ManagedProvider {
            id: id.into(),
            name: format!("Provider {id}"),
            kind: "gateway".into(),
            gateway_path: format!("/gateway/{id}/v1"),
            wire_api: "responses".into(),
            models: models
                .iter()
                .map(|m| ManagedModel {
                    id: (*m).into(),
                    display_name: m.to_uppercase(),
                })
                .collect(),
            default_model: default.into(),
            daily_token_limit: None,
            used_tokens_today: 0,
        }
    }

    fn gateway<'a>(providers: &'a [ManagedProvider], key: &'a str) -> DesiredGateway<'a> {
        DesiredGateway {
            server_url: "https://ent.example.com",
            gateway_key: key,
            providers,
        }
    }

    fn table(cards: Vec<Provider>) -> IndexMap<String, Provider> {
        cards.into_iter().map(|p| (p.id.clone(), p)).collect()
    }

    #[test]
    fn managed_provider_deserializes_contract_shape_and_defaults() {
        let full: ManagedProvider = serde_json::from_value(json!({
            "id": "openai-main",
            "name": "OpenAI",
            "kind": "gateway",
            "gatewayPath": "/gateway/openai-main/v1",
            "wireApi": "responses",
            "models": [{ "id": "gpt-5", "displayName": "GPT-5" }],
            "defaultModel": "gpt-5",
            "dailyTokenLimit": null,
            "usedTokensToday": 12
        }))
        .unwrap();
        assert_eq!(full.gateway_path, "/gateway/openai-main/v1");
        assert_eq!(full.daily_token_limit, None);
        assert_eq!(full.used_tokens_today, 12);

        let minimal: ManagedProvider = serde_json::from_value(json!({ "id": "x" })).unwrap();
        assert_eq!(minimal.kind, "gateway");
        assert_eq!(minimal.wire_api, "responses");
        assert!(minimal.models.is_empty());
        assert_eq!(
            gateway_base_url("https://ent.example.com/", &minimal),
            "https://ent.example.com/gateway/x/v1"
        );
    }

    #[test]
    fn config_toml_is_third_party_shape_and_escapes() {
        let text = build_config_toml(
            "Acme \"GW\"",
            "https://ent.example.com/gateway/a/v1",
            "gpt-5",
        );
        let parsed: toml::Value = text.parse().unwrap();
        assert_eq!(parsed["model_provider"].as_str(), Some("custom"));
        assert_eq!(parsed["model"].as_str(), Some("gpt-5"));
        let custom = &parsed["model_providers"]["custom"];
        assert_eq!(custom["name"].as_str(), Some("Acme \"GW\""));
        assert_eq!(
            custom["base_url"].as_str(),
            Some("https://ent.example.com/gateway/a/v1")
        );
        assert_eq!(custom["wire_api"].as_str(), Some("responses"));
        assert_eq!(custom["requires_openai_auth"].as_bool(), Some(true));
        assert!(text.contains("[model_providers.custom]"));
        assert_eq!(config_model(&text).as_deref(), Some("gpt-5"));
    }

    #[test]
    fn set_config_model_preserves_formatting() {
        let text = "# my config\nmodel_provider = \"custom\"\nmodel = \"a\" # pinned\n\n[model_providers.custom]\nname = \"x\"\n";
        let next = set_config_model(text, "b").unwrap();
        assert_eq!(
            next,
            "# my config\nmodel_provider = \"custom\"\nmodel = \"b\" # pinned\n\n[model_providers.custom]\nname = \"x\"\n"
        );
        let added = set_config_model("model_provider = \"custom\"\n", "c").unwrap();
        assert_eq!(config_model(&added).as_deref(), Some("c"));
        assert!(set_config_model("not = [valid", "c").is_err());
    }

    #[test]
    fn plan_creates_cards_with_gateway_auth_and_meta() {
        let providers = [managed(
            "openai-main",
            &["gpt-5", "gpt-5-mini"],
            "gpt-5-mini",
        )];
        let plan = plan_sync(&IndexMap::new(), Some(&gateway(&providers, "gk_1")), 42);
        assert_eq!(plan.create.len(), 1);
        assert!(plan.update.is_empty() && plan.delete.is_empty());
        let card = &plan.create[0];
        assert_eq!(card.id, "ccse-openai-main");
        assert_eq!(card.name, "Provider openai-main");
        assert_eq!(card.category.as_deref(), Some("custom"));
        assert_eq!(card.created_at, Some(42));
        assert_eq!(card.settings_config["auth"]["OPENAI_API_KEY"], "gk_1");
        let config = card.settings_config["config"].as_str().unwrap();
        assert_eq!(config_model(config).as_deref(), Some("gpt-5-mini"));
        assert!(config.contains("https://ent.example.com/gateway/openai-main/v1"));
        assert_eq!(
            card.settings_config["modelCatalog"]["models"],
            json!([
                { "model": "gpt-5", "displayName": "GPT-5" },
                { "model": "gpt-5-mini", "displayName": "GPT-5-MINI" },
            ])
        );
        let meta = enterprise_meta(card).unwrap();
        assert_eq!(meta.provider_id, "openai-main");
        assert_eq!(meta.server_url, "https://ent.example.com");
        assert_eq!(meta.models.len(), 2);
        assert_eq!(meta.models[0].display_name, "GPT-5");
    }

    #[test]
    fn plan_keeps_user_model_and_skips_unchanged() {
        let providers = [managed("p", &["m1", "m2"], "m1")];
        let first = plan_sync(&IndexMap::new(), Some(&gateway(&providers, "gk_1")), 1);
        let mut card = first.create[0].clone();
        card.sort_index = Some(7);
        card.settings_config["config"] = Value::String(
            set_config_model(card.settings_config["config"].as_str().unwrap(), "m2").unwrap(),
        );
        let existing = table(vec![card]);

        // Same key, same offer: nothing to do (user's m2 is kept).
        let plan = plan_sync(&existing, Some(&gateway(&providers, "gk_1")), 2);
        assert!(plan.is_empty(), "{plan:?}");

        // New gateway key after re-login: update, keep m2 and local fields.
        let plan = plan_sync(&existing, Some(&gateway(&providers, "gk_2")), 2);
        assert_eq!(plan.update.len(), 1);
        let updated = &plan.update[0];
        assert_eq!(updated.settings_config["auth"]["OPENAI_API_KEY"], "gk_2");
        assert_eq!(
            config_model(updated.settings_config["config"].as_str().unwrap()).as_deref(),
            Some("m2")
        );
        assert_eq!(updated.sort_index, Some(7));
        assert_eq!(updated.created_at, Some(1));

        // m2 withdrawn: fall back to the default model.
        let narrowed = [managed("p", &["m1"], "m1")];
        let plan = plan_sync(&existing, Some(&gateway(&narrowed, "gk_1")), 2);
        assert_eq!(plan.update.len(), 1);
        assert_eq!(
            config_model(plan.update[0].settings_config["config"].as_str().unwrap()).as_deref(),
            Some("m1")
        );
    }

    #[test]
    fn plan_deletes_only_managed_cards_no_longer_offered() {
        let providers = [managed("a", &["m"], "m"), managed("b", &["m"], "m")];
        let created = plan_sync(&IndexMap::new(), Some(&gateway(&providers, "k")), 1).create;
        let mut cards = created;
        let mut user_card = Provider::with_id(
            "user-1".into(),
            "Mine".into(),
            json!({ "auth": {}, "config": "" }),
            None,
        );
        user_card.meta = Some(ProviderMeta::default());
        cards.push(user_card);
        let existing = table(cards);

        let only_a = [managed("a", &["m"], "m")];
        let plan = plan_sync(&existing, Some(&gateway(&only_a, "k")), 2);
        assert_eq!(plan.delete, vec!["ccse-b".to_string()]);
        assert!(plan.create.is_empty() && plan.update.is_empty());

        // Logged out: every managed card goes, user cards stay.
        let plan = plan_sync(&existing, None, 2);
        let mut deleted = plan.delete.clone();
        deleted.sort();
        assert_eq!(deleted, vec!["ccse-a".to_string(), "ccse-b".to_string()]);
    }

    #[test]
    fn model_change_validates_enterprise_and_catalog_models() {
        let providers = [managed("p", &["m1", "m2"], "m1")];
        let card = plan_sync(&IndexMap::new(), Some(&gateway(&providers, "k")), 1)
            .create
            .remove(0);
        assert!(apply_model_change(&card, "m1").unwrap().is_none());
        let next = apply_model_change(&card, " m2 ").unwrap().unwrap();
        assert_eq!(
            config_model(next.settings_config["config"].as_str().unwrap()).as_deref(),
            Some("m2")
        );
        assert_eq!(next.settings_config["auth"], card.settings_config["auth"]);
        assert!(apply_model_change(&card, "other").is_err());
        assert!(apply_model_change(&card, "  ").is_err());

        let catalog_card = Provider::with_id(
            "c".into(),
            "Catalog".into(),
            json!({
                "auth": { "OPENAI_API_KEY": "sk" },
                "config": "model = \"k3\"\n",
                "modelCatalog": { "models": [{ "model": "k3" }, { "model": "k2" }] }
            }),
            None,
        );
        assert!(apply_model_change(&catalog_card, "k2").unwrap().is_some());
        assert!(apply_model_change(&catalog_card, "zzz").is_err());

        let plain = Provider::with_id(
            "d".into(),
            "Plain".into(),
            json!({ "auth": {}, "config": "model = \"a\"\n" }),
            None,
        );
        assert!(apply_model_change(&plain, "anything").unwrap().is_some());
    }
}

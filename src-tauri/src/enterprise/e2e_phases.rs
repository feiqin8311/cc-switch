//! Live end-to-end tests of the enterprise phases (gateway, retention,
//! marketplace) against a REAL enterprise server. Ignored by default.
//!
//! ```sh
//! # server:   cd enterprise/server && PORT=4300 DATA_DIR=<tmp> \
//! #             ADMIN_PASSWORD=e2e-admin-password node src/index.ts
//! # upstream: a fake OpenAI Responses API on 127.0.0.1:4301 that answers
//! #           POST /v1/responses with SSE and lists what it saw on GET /_seen
//! CC_SWITCH_TEST_HOME=<empty tmp dir> \
//! CCSE_E2E_SERVER=http://127.0.0.1:4300 CCSE_E2E_PASSWORD=e2e-admin-password \
//!   cargo test --lib enterprise -- --ignored --nocapture
//! ```
//!
//! The tests seed the server themselves (idempotent) through the admin API:
//! a member user, a gateway provider pointing at the fake upstream, an enabled
//! retention policy and a skill + plugin in the marketplace.
//!
//! Client side everything is hermetic: sessions / stores live in temp dirs, the
//! provider table and the skill DB are in-memory databases, and the global home
//! (`~/.codex`, `~/.cc-switch`) is redirected with `CC_SWITCH_TEST_HOME` (set to a
//! fresh temp dir by the tests when the caller did not set it). The real Codex
//! CLI is never invoked.
//!
//! Env (defaults in parentheses): `CCSE_E2E_SERVER`, `CCSE_E2E_PASSWORD` (admin
//! password, required), `CCSE_E2E_USER` (`admin`), `CCSE_E2E_MEMBER`
//! (`e2e-member`), `CCSE_E2E_MEMBER_PASSWORD` (`e2e-member-password`),
//! `CCSE_E2E_PROVIDER` (`e2e-up`), `CCSE_E2E_UPSTREAM` (`http://127.0.0.1:4301`).

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::client::endpoint;
use super::market::{self, MarketItemKind, MarketPaths};
use super::providers::{apply_sync, enterprise_meta, managed_card_id, DesiredGateway};
use super::retention::{
    ack_key, file_sig, prepare_candidate, save_store, select_candidates, state_file_path,
    RetentionService, RetentionStore,
};
use super::session::EnterpriseSession;
use crate::app_config::AppType;
use crate::database::Database;
use crate::services::skill::SkillService;
use crate::services::ProviderService;
use crate::session_manager::providers::codex;
use crate::store::AppState;

const MEMBER_DISPLAY: &str = "E2E Member";
const MODEL_A: &str = "gpt-e2e";
const MODEL_B: &str = "gpt-e2e-mini";
const DAILY_LIMIT: u64 = 1_000_000;
const NOTICE: &str = "E2E: Codex conversations are retained by the company.";
const SKILL_ID: &str = "e2e-skill";
const PLUGIN_ID: &str = "e2e-plugin";

// ─── Environment ────────────────────────────────────────────────────────

#[derive(Clone)]
struct Env {
    server: String,
    admin_user: String,
    admin_password: String,
    member: String,
    member_password: String,
    provider: String,
    upstream: String,
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// `None` (test skipped) when the server / admin password are not configured.
fn live_env() -> Option<Env> {
    let Ok(server) = std::env::var("CCSE_E2E_SERVER") else {
        eprintln!("CCSE_E2E_SERVER not set, skipping");
        return None;
    };
    let Ok(admin_password) = std::env::var("CCSE_E2E_PASSWORD") else {
        eprintln!("CCSE_E2E_PASSWORD not set, skipping");
        return None;
    };
    Some(Env {
        server: server.trim_end_matches('/').to_string(),
        admin_user: env_or("CCSE_E2E_USER", "admin"),
        admin_password,
        member: env_or("CCSE_E2E_MEMBER", "e2e-member"),
        member_password: env_or("CCSE_E2E_MEMBER_PASSWORD", "e2e-member-password"),
        provider: env_or("CCSE_E2E_PROVIDER", "e2e-up"),
        upstream: env_or("CCSE_E2E_UPSTREAM", "http://127.0.0.1:4301")
            .trim_end_matches('/')
            .to_string(),
    })
}

/// Redirect the global home (`~/.codex`, `~/.cc-switch`, skill dirs) to a temp
/// dir before anything resolves it, and refuse to run against the real home.
fn isolated_home() -> PathBuf {
    static HOME: OnceLock<PathBuf> = OnceLock::new();
    let home = HOME
        .get_or_init(|| {
            if let Some(existing) = std::env::var_os("CC_SWITCH_TEST_HOME")
                .filter(|v| !v.to_string_lossy().trim().is_empty())
            {
                return PathBuf::from(existing);
            }
            // Kept for the whole process (statics are never dropped).
            let dir = tempfile::Builder::new()
                .prefix("ccse-e2e-home-")
                .tempdir()
                .expect("temp home")
                .keep();
            std::env::set_var("CC_SWITCH_TEST_HOME", &dir);
            dir
        })
        .clone();
    let resolved = crate::config::get_home_dir();
    assert_eq!(resolved, home, "CC_SWITCH_TEST_HOME must be in effect");
    if let Some(real) = dirs::home_dir() {
        assert_ne!(resolved, real, "refusing to run against the real home dir");
    }
    let codex = crate::codex_config::get_codex_config_dir();
    assert!(
        codex.starts_with(&home),
        "Codex dir {} is outside the test home",
        codex.display()
    );
    assert!(crate::config::get_app_config_dir().starts_with(&home));
    home
}

// ─── Admin API helpers (seeding / verification) ─────────────────────────

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap()
}

async fn login_token(env: &Env, user: &str, password: &str) -> (String, Value) {
    let resp = http()
        .post(endpoint(&env.server, "/auth/login"))
        .json(&json!({ "username": user, "password": password }))
        .send()
        .await
        .expect("server reachable");
    assert!(
        resp.status().is_success(),
        "login {user}: {}",
        resp.status()
    );
    let body: Value = resp.json().await.unwrap();
    (
        body["accessToken"].as_str().unwrap().to_string(),
        body["user"].clone(),
    )
}

async fn admin_token(env: &Env) -> String {
    login_token(env, &env.admin_user, &env.admin_password)
        .await
        .0
}

async fn admin_get(env: &Env, token: &str, path: &str) -> Value {
    let resp = http()
        .get(endpoint(&env.server, path))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "GET {path}: {}", resp.status());
    resp.json().await.unwrap()
}

fn zip_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zw = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    for (name, data) in files {
        zw.start_file(*name, opts).unwrap();
        zw.write_all(data).unwrap();
    }
    zw.finish().unwrap().into_inner()
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn skill_zip() -> Vec<u8> {
    zip_bytes(&[
        (
            "e2e-skill/SKILL.md",
            b"---\nname: e2e-skill\ndescription: E2E test skill\n---\n\n# E2E skill\nSay hi.\n",
        ),
        ("e2e-skill/notes.txt", b"helper\n"),
    ])
}

fn plugin_zip() -> Vec<u8> {
    zip_bytes(&[
        (
            ".codex-plugin/plugin.json",
            br#"{"name":"e2e-plugin","version":"1.0.0","description":"E2E plugin"}"#,
        ),
        (
            "skills/hello/SKILL.md",
            b"---\nname: hello\ndescription: hi\n---\nhi\n",
        ),
    ])
}

/// Idempotent seeding through the admin API.
async fn seed(env: &Env) {
    let token = admin_token(env).await;
    let c = http();

    // Member user (409 = exists).
    let resp = c
        .post(endpoint(&env.server, "/admin/users"))
        .bearer_auth(&token)
        .json(&json!({
            "username": env.member, "displayName": MEMBER_DISPLAY,
            "password": env.member_password, "role": "member",
        }))
        .send()
        .await
        .unwrap();
    assert!(
        resp.status().is_success() || resp.status().as_u16() == 409,
        "create member: {}",
        resp.status()
    );

    // Gateway provider: create, or reset to the expected fields.
    let fields = json!({
        "name": "E2E Upstream",
        "baseUrl": format!("{}/v1", env.upstream),
        "apiKey": "upstream-secret",
        "models": [
            { "id": MODEL_A, "displayName": "GPT E2E" },
            { "id": MODEL_B, "displayName": "GPT E2E Mini" },
        ],
        "defaultModel": MODEL_A,
        "allowedRoles": ["member", "admin"],
        "dailyTokenLimitPerUser": DAILY_LIMIT,
        "enabled": true,
    });
    let mut create = fields.clone();
    create["id"] = json!(env.provider);
    let resp = c
        .post(endpoint(&env.server, "/admin/providers"))
        .bearer_auth(&token)
        .json(&create)
        .send()
        .await
        .unwrap();
    if resp.status().as_u16() == 409 {
        let resp = c
            .patch(endpoint(
                &env.server,
                &format!("/admin/providers/{}", env.provider),
            ))
            .bearer_auth(&token)
            .json(&fields)
            .send()
            .await
            .unwrap();
        assert!(
            resp.status().is_success(),
            "patch provider: {}",
            resp.status()
        );
    } else {
        assert!(
            resp.status().is_success(),
            "create provider: {}",
            resp.status()
        );
    }

    // Retention policy.
    let resp = c
        .put(endpoint(&env.server, "/admin/retention-policy"))
        .bearer_auth(&token)
        .json(&json!({ "enabled": true, "noticeText": NOTICE, "retentionDays": 30 }))
        .send()
        .await
        .unwrap();
    assert!(
        resp.status().is_success(),
        "retention policy: {}",
        resp.status()
    );

    // Marketplace items (PUT = create or replace).
    for (id, kind, mandatory, data) in [
        (SKILL_ID, "skill", "false", skill_zip()),
        (PLUGIN_ID, "plugin", "true", plugin_zip()),
    ] {
        let resp = c
            .put(endpoint(&env.server, &format!("/admin/market/items/{id}")))
            .bearer_auth(&token)
            .query(&[
                ("kind", kind),
                ("name", id),
                ("description", "E2E item"),
                ("version", "1.0.0"),
                ("mandatory", mandatory),
            ])
            .header(reqwest::header::CONTENT_TYPE, "application/zip")
            .body(data.clone())
            .send()
            .await
            .unwrap();
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        assert!(status.is_success(), "publish {id}: {status} {body}");
        assert_eq!(body["sha256"].as_str(), Some(sha256_hex(&data).as_str()));
    }
}

async fn seeded() -> Option<Env> {
    static SEEDED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
    let env = live_env()?;
    isolated_home();
    let for_seed = env.clone();
    SEEDED
        .get_or_init(|| async move { seed(&for_seed).await })
        .await;
    Some(env)
}

async fn member_session(env: &Env, dir: &Path) -> EnterpriseSession {
    let session = EnterpriseSession::new(dir.to_path_buf());
    let state = session
        .login(&env.server, &env.member, &env.member_password)
        .await
        .expect("member login");
    assert!(state.logged_in, "{state:?}");
    assert!(state.last_error.is_none(), "{:?}", state.last_error);
    session
}

// ─── (a) Gateway ────────────────────────────────────────────────────────

#[tokio::test]
#[ignore = "needs a live enterprise server (CCSE_E2E_SERVER / CCSE_E2E_PASSWORD)"]
async fn e2e_gateway_managed_provider_and_streaming() {
    let Some(env) = seeded().await else { return };
    let dir = tempfile::tempdir().unwrap();
    let session = member_session(&env, dir.path()).await;

    // Config carries the provider with its gateway path and quota.
    let state = session.state().await;
    assert!(state.permissions.iter().any(|p| p == "models.use"));
    let config = state.config.as_ref().expect("config");
    let managed = config
        .providers
        .iter()
        .find(|p| p.id == env.provider)
        .expect("provider offered to the member")
        .clone();
    assert_eq!(
        managed.gateway_path,
        format!("/gateway/{}/v1", env.provider)
    );
    assert_eq!(managed.kind, "gateway");
    assert_eq!(managed.wire_api, "responses");
    let ids: Vec<&str> = managed.models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec![MODEL_A, MODEL_B]);
    assert_eq!(managed.daily_token_limit, Some(DAILY_LIMIT));
    let used_before = managed.used_tokens_today;
    eprintln!(
        "[e2e-gw] provider {} at {}, usedTokensToday {used_before}",
        managed.id, managed.gateway_path
    );

    // Gateway key through the same path `run_sync` uses.
    let snapshot = session
        .managed_providers_snapshot()
        .await
        .expect("snapshot");
    assert!(snapshot.wants_gateway());
    let (base, key) = session.ensure_gateway_key().await.expect("gateway key");
    assert_eq!(base, env.server);
    assert!(key.starts_with("gk_"), "unexpected key format");
    let (_, again) = session.ensure_gateway_key().await.unwrap();
    assert_eq!(again, key, "the key is cached per login session");
    let stored =
        std::fs::read_to_string(dir.path().join(super::session::SESSION_FILE_NAME)).unwrap();
    assert!(!stored.contains("accessToken"));

    // Managed-provider sync into an in-memory provider table.
    let app_state = AppState::new(Arc::new(Database::memory().expect("memory db")));
    let sync =
        |state: AppState,
         providers: Option<(String, String, Vec<super::types::ManagedProvider>)>| {
            tokio::task::spawn_blocking(move || {
                let gateway = providers
                    .as_ref()
                    .map(|(server_url, gateway_key, providers)| DesiredGateway {
                        server_url,
                        gateway_key,
                        providers,
                    });
                apply_sync(&state, gateway.as_ref())
            })
        };
    let desired = Some((
        snapshot.server_url.clone(),
        key.clone(),
        snapshot.providers.clone(),
    ));
    let changed = sync(app_state.clone(), desired.clone())
        .await
        .unwrap()
        .expect("sync");
    assert!(changed, "first sync must create the card");
    let cards = ProviderService::list(&app_state, AppType::Codex).unwrap();
    let card = cards
        .get(&managed_card_id(&env.provider))
        .expect("ccse-<id> card");
    assert_eq!(card.id, format!("ccse-{}", env.provider));
    assert_eq!(card.settings_config["auth"]["OPENAI_API_KEY"], key.as_str());
    let toml: toml::Value = card.settings_config["config"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let base_url = toml["model_providers"]["custom"]["base_url"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(base_url, format!("{}{}", env.server, managed.gateway_path));
    assert_eq!(toml["model"].as_str(), Some(MODEL_A));
    assert_eq!(
        toml["model_providers"]["custom"]["wire_api"].as_str(),
        Some("responses")
    );
    let meta = enterprise_meta(card).expect("meta.enterprise");
    assert_eq!(meta.server_url, env.server);
    assert_eq!(meta.provider_id, env.provider);
    assert_eq!(meta.models.len(), 2);
    let changed = sync(app_state.clone(), desired).await.unwrap().unwrap();
    assert!(!changed, "second sync with the same offer is a no-op");
    eprintln!("[e2e-gw] synced card {} → {base_url}", card.id);

    // Real streaming request through the gateway with the gateway key.
    let resp = http()
        .post(format!("{base_url}/responses"))
        .bearer_auth(&key)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .json(&json!({ "model": MODEL_A, "input": "say hi", "stream": true }))
        .send()
        .await
        .expect("gateway reachable");
    assert_eq!(resp.status().as_u16(), 200);
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(ct.contains("text/event-stream"), "content-type {ct}");
    let body = resp.text().await.unwrap();
    assert!(body.contains("response.output_text.delta"), "{body}");
    assert!(body.contains("hello from fake upstream"));
    assert!(body.contains("response.completed"));

    // The upstream saw the provider's key, never the gateway key.
    let seen: Vec<Value> = http()
        .get(format!("{}/_seen", env.upstream))
        .send()
        .await
        .expect("fake upstream reachable")
        .json()
        .await
        .unwrap();
    let last = seen.last().expect("upstream got the request");
    assert_eq!(last["authorization"], "Bearer upstream-secret");
    assert_eq!(last["model"], MODEL_A);
    assert!(seen
        .iter()
        .all(|s| !s["authorization"].as_str().unwrap_or("").contains("gk_")));

    // Usage is recorded from `response.completed` (fake upstream: 11 + 7).
    let state = session.refresh_config().await.unwrap();
    let used_after = state
        .config
        .as_ref()
        .unwrap()
        .providers
        .iter()
        .find(|p| p.id == env.provider)
        .unwrap()
        .used_tokens_today;
    assert!(
        used_after >= used_before + 18,
        "usedTokensToday {used_before} → {used_after}"
    );
    eprintln!("[e2e-gw] usedTokensToday {used_before} → {used_after}");

    // A model outside the list → 400; a bad key → 401.
    let resp = http()
        .post(format!("{base_url}/responses"))
        .bearer_auth(&key)
        .json(&json!({ "model": "not-offered", "input": "x", "stream": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 400);
    let err: Value = resp.json().await.unwrap();
    assert_eq!(err["error"]["code"], "bad_request");
    let resp = http()
        .post(format!("{base_url}/responses"))
        .bearer_auth("gk_not-a-real-key")
        .json(&json!({ "model": MODEL_A, "input": "x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 401);

    // Logout: the sync removes the card again, and the key dies with the session.
    session.logout().await;
    assert!(session.managed_providers_snapshot().await.is_none());
    let changed = sync(app_state.clone(), None).await.unwrap().unwrap();
    assert!(changed);
    let cards = ProviderService::list(&app_state, AppType::Codex).unwrap();
    assert!(!cards.contains_key(&managed_card_id(&env.provider)));
    tokio::time::sleep(Duration::from_millis(1500)).await; // background revoke
    let resp = http()
        .post(format!("{base_url}/responses"))
        .bearer_auth(&key)
        .json(&json!({ "model": MODEL_A, "input": "x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 401, "gateway key revoked by logout");
    eprintln!("[e2e-gw] all steps passed");
}

// ─── (b) Retention ──────────────────────────────────────────────────────

fn rfc3339(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// A small Codex rollout (same shape as the retention unit tests) whose
/// lines are stamped from `start`; mtime is set to `mtime` (idle file).
fn write_rollout(
    home: &Path,
    session_id: &str,
    start: DateTime<Utc>,
    prompt: &str,
    mtime: SystemTime,
) -> PathBuf {
    let mut n = 0i64;
    let mut line = |ty: &str, payload: Value| {
        n += 1;
        json!({
            "timestamp": rfc3339(start + chrono::Duration::seconds(n)),
            "type": ty,
            "payload": payload,
        })
        .to_string()
    };
    let lines = vec![
        line(
            "session_meta",
            json!({ "id": session_id, "cwd": "/tmp/e2e-project", "timestamp": rfc3339(start) }),
        ),
        line("turn_context", json!({ "turn_id": "t1", "model": "gpt-5" })),
        line(
            "response_item",
            json!({ "type": "message", "role": "user",
                "content": [{ "type": "input_text", "text": "# AGENTS.md instructions for /tmp/e2e-project" }] }),
        ),
        line(
            "response_item",
            json!({ "type": "message", "role": "user",
                "content": [{ "type": "input_text", "text": prompt }] }),
        ),
        line(
            "response_item",
            json!({ "type": "reasoning", "summary": [{ "type": "summary_text", "text": "plan" }] }),
        ),
        line(
            "response_item",
            json!({ "type": "function_call", "name": "exec_command",
                "arguments": "{\"cmd\":\"ls\"}", "call_id": "c1" }),
        ),
        line(
            "response_item",
            json!({ "type": "function_call_output", "call_id": "c1", "output": "a.txt" }),
        ),
        line(
            "response_item",
            json!({ "type": "message", "role": "assistant",
                "content": [{ "type": "output_text", "text": "done" }] }),
        ),
    ];
    let day = home
        .join(".codex")
        .join("sessions")
        .join(start.format("%Y/%m/%d").to_string());
    std::fs::create_dir_all(&day).unwrap();
    let path = day.join(format!(
        "rollout-{}-{session_id}.jsonl",
        start.format("%Y-%m-%dT%H-%M-%S")
    ));
    std::fs::write(&path, lines.join("\n") + "\n").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(mtime)
        .unwrap();
    path
}

async fn upload_raw(
    session: &EnterpriseSession,
    items: &[&super::retention::ConversationUpload],
) -> (i64, i64) {
    let body = serde_json::to_vec(&json!({ "items": items })).unwrap();
    let (_, resp) = session
        .send_authenticated(|http, base, token| {
            http.post(endpoint(base, "/retention/conversations"))
                .bearer_auth(token)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.clone())
        })
        .await
        .expect("upload accepted");
    let v: Value = resp.json().await.unwrap();
    (
        v["accepted"].as_i64().expect("accepted"),
        v["duplicates"].as_i64().expect("duplicates"),
    )
}

async fn conversations_of(env: &Env, admin: &str, user_id: &str) -> Vec<Value> {
    let v = admin_get(
        env,
        admin,
        &format!("/admin/conversations?userId={user_id}&limit=200"),
    )
    .await;
    v["items"].as_array().cloned().unwrap_or_default()
}

#[tokio::test]
#[ignore = "needs a live enterprise server (CCSE_E2E_SERVER / CCSE_E2E_PASSWORD)"]
async fn e2e_retention_mapping_and_upload() {
    let Some(env) = seeded().await else { return };
    let home = isolated_home();
    let dir = tempfile::tempdir().unwrap();
    let session = Arc::new(member_session(&env, dir.path()).await);
    let state = session.state().await;
    let policy = &state.config.as_ref().unwrap().retention;
    assert!(policy.enabled);
    assert_eq!(policy.notice_text, NOTICE);
    let server_url = state.server_url.clone().unwrap();
    let user_id = state.user.as_ref().unwrap().id.clone();

    // Ack 60 min ago; A and B start after it, C before it. All files idle.
    let now = Utc::now();
    let ack = now - chrono::Duration::minutes(60);
    let idle = SystemTime::now() - Duration::from_secs(20 * 60);
    let (id_a, id_b, id_c) = (
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
    );
    write_rollout(
        &home,
        &id_a,
        now - chrono::Duration::minutes(40),
        "list files",
        idle,
    );
    write_rollout(
        &home,
        &id_b,
        now - chrono::Duration::minutes(30),
        "second session",
        idle,
    );
    write_rollout(
        &home,
        &id_c,
        now - chrono::Duration::minutes(90),
        "before the ack",
        idle,
    );

    // Candidate selection over the (test-home) Codex sessions.
    let ack_ms = ack.timestamp_millis();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let sessions = tokio::task::spawn_blocking(codex::scan_sessions)
        .await
        .unwrap();
    let candidates = select_candidates(sessions, ack_ms, &BTreeMap::new(), now_ms, &file_sig);
    let find = |id: &str| candidates.iter().find(|c| c.session_id == id).cloned();
    let (cand_a, cand_b) = (
        find(&id_a).expect("A selected"),
        find(&id_b).expect("B selected"),
    );
    assert!(
        find(&id_c).is_none(),
        "a session started before the ack is never sent"
    );
    assert!(cand_a.idle && cand_b.idle);

    // Mapping: injected AGENTS.md dropped, block-level split, all settled.
    let chunks_a = prepare_candidate(&cand_a).expect("prepare A");
    let chunks_b = prepare_candidate(&cand_b).expect("prepare B");
    assert_eq!(chunks_a.len(), 1);
    let upload_a = &chunks_a[0].upload;
    assert_eq!(upload_a.client_session_id, id_a);
    assert_eq!(upload_a.project_dir.as_deref(), Some("/tmp/e2e-project"));
    let kinds: Vec<_> = upload_a.messages.iter().map(|m| m.kind).collect();
    assert_eq!(
        kinds,
        vec![
            "message",
            "reasoning",
            "tool_call",
            "tool_result",
            "message"
        ]
    );
    assert!(upload_a
        .messages
        .iter()
        .all(|m| !m.content.contains("AGENTS.md")));
    assert_eq!(upload_a.messages[0].content, "list files");
    assert_eq!(
        upload_a.messages[3].tool_name.as_deref(),
        Some("exec_command")
    );
    assert!(chunks_a[0].completes_file.is_some());
    let n_a = upload_a.messages.len() as i64;
    let n_b: i64 = chunks_b
        .iter()
        .map(|c| c.upload.messages.len() as i64)
        .sum();

    // Upload A with the module's payload: accepted, then all duplicates.
    let (accepted, duplicates) = upload_raw(&session, &[upload_a]).await;
    assert_eq!((accepted, duplicates), (n_a, 0));
    let (accepted, duplicates) = upload_raw(&session, &[upload_a]).await;
    assert_eq!((accepted, duplicates), (0, n_a));
    eprintln!("[e2e-ret] A: accepted {n_a}, re-upload → duplicates {n_a}");

    // The background service (real pass: scan → prepare → batch → upload).
    let store = RetentionStore {
        acks: BTreeMap::from([(ack_key(&server_url, &user_id), rfc3339(ack))]),
        ..Default::default()
    };
    save_store(&state_file_path(dir.path()), &store).unwrap();
    let service = RetentionService::new(session.clone(), dir.path().to_path_buf());
    let status = service.status().await;
    assert!(status.enabled && status.acknowledged, "{status:?}");
    assert_eq!(status.notice_text, NOTICE);
    service.trigger();
    let task = tokio::spawn(service.clone().run_loop());
    let mut status = service.status().await;
    for _ in 0..150 {
        if status.last_upload_at.is_some() || status.last_error.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        status = service.status().await;
    }
    assert!(status.last_error.is_none(), "{status:?}");
    assert!(
        status.last_upload_at.is_some(),
        "service uploaded: {status:?}"
    );
    assert_eq!(
        status.uploaded_sessions, 2,
        "A and B have cursors: {status:?}"
    );
    let stored = std::fs::read_to_string(state_file_path(dir.path())).unwrap();
    assert!(stored.contains(&id_a) && stored.contains(&id_b) && !stored.contains(&id_c));

    // A second pass finds nothing new (cursors are current).
    let first_upload = status.last_upload_at.clone();
    service.trigger();
    tokio::time::sleep(Duration::from_secs(2)).await;
    let status = service.status().await;
    assert_eq!(status.last_upload_at, first_upload);
    assert!(status.last_error.is_none());
    task.abort();

    // Admin view: A once (no duplicated messages), B present, C absent.
    let admin = admin_token(&env).await;
    let items = conversations_of(&env, &admin, &user_id).await;
    let by_session = |id: &str| items.iter().find(|c| c["clientSessionId"] == id).cloned();
    let conv_a = by_session(&id_a).expect("A retained");
    let conv_b = by_session(&id_b).expect("B retained");
    assert!(by_session(&id_c).is_none(), "C must never be uploaded");
    assert_eq!(conv_a["messageCount"].as_i64(), Some(n_a));
    assert_eq!(conv_b["messageCount"].as_i64(), Some(n_b));
    assert_eq!(conv_a["user"]["username"], env.member.as_str());
    assert_eq!(conv_a["projectDir"], "/tmp/e2e-project");
    let detail = admin_get(
        &env,
        &admin,
        &format!("/admin/conversations/{}", conv_a["id"].as_str().unwrap()),
    )
    .await;
    let messages = detail["messages"].as_array().unwrap();
    let seqs: Vec<i64> = messages
        .iter()
        .map(|m| m["seq"].as_i64().unwrap())
        .collect();
    assert_eq!(seqs, (0..n_a).collect::<Vec<_>>());
    assert_eq!(messages[0]["content"], "list files");
    assert_eq!(messages[2]["kind"], "tool_call");
    assert_eq!(messages[3]["toolName"], "exec_command");
    eprintln!("[e2e-ret] admin sees A ({n_a} msgs) and B ({n_b} msgs), not C; all steps passed");
    session.logout().await;
}

// ─── (c) Marketplace ────────────────────────────────────────────────────

#[tokio::test]
#[ignore = "needs a live enterprise server (CCSE_E2E_SERVER / CCSE_E2E_PASSWORD)"]
async fn e2e_market_list_download_verify_extract() {
    let Some(env) = seeded().await else { return };
    let home = isolated_home();
    let dir = tempfile::tempdir().unwrap();
    let session = member_session(&env, &dir.path().join("cfg")).await;
    let db = Arc::new(Database::memory().expect("memory db"));
    let paths = MarketPaths::new(&dir.path().join("cfg"));

    // List as the member (market.install).
    let entries = market::list(&session, &db, &paths).await.expect("list");
    let entry = |id: &str| entries.iter().find(|e| e.item.id == id).cloned();
    let skill = entry(SKILL_ID).expect("skill listed");
    let plugin = entry(PLUGIN_ID).expect("plugin listed");
    assert_eq!(skill.item.kind, MarketItemKind::Skill);
    assert_eq!(plugin.item.kind, MarketItemKind::Plugin);
    assert!(plugin.item.mandatory && !skill.item.mandatory);
    assert_eq!(skill.item.sha256, sha256_hex(&skill_zip()));
    assert_eq!(plugin.item.sha256, sha256_hex(&plugin_zip()));
    assert!(skill.installed_version.is_none() && plugin.installed_version.is_none());

    // Download + sha verify + safe extract, both kinds.
    for (item, marker, expect) in [
        (&skill.item, "SKILL.md", vec!["SKILL.md", "notes.txt"]),
        (
            &plugin.item,
            ".codex-plugin/plugin.json",
            vec![".codex-plugin/plugin.json", "skills/hello/SKILL.md"],
        ),
    ] {
        let package = market::download_package(&session, item)
            .await
            .unwrap_or_else(|e| panic!("download {}: {e}", item.id));
        let bytes = std::fs::read(package.path()).unwrap();
        assert_eq!(sha256_hex(&bytes), item.sha256);
        let dest = dir.path().join("extract").join(&item.id);
        market::safe_extract_package(package.path(), &dest, marker)
            .unwrap_or_else(|e| panic!("extract {}: {e}", item.id));
        for file in expect {
            assert!(dest.join(file).is_file(), "{} missing {file}", item.id);
        }
    }
    market::validate_plugin_dir(&dir.path().join("extract").join(PLUGIN_ID), PLUGIN_ID)
        .expect("plugin.json name == id");

    // Tamper: a wrong listed digest is rejected.
    let mut tampered = skill.item.clone();
    tampered.sha256 = "0".repeat(64);
    let err = market::download_package(&session, &tampered)
        .await
        .err()
        .expect("wrong sha must fail");
    assert!(err.contains("checksum"), "{err}");
    eprintln!("[e2e-mkt] tamper rejected: {err}");

    // Full skill install through the module (test home + in-memory DB).
    let installed = market::install(&session, &db, &paths, SKILL_ID)
        .await
        .expect("install skill");
    assert_eq!(installed.installed_version.as_deref(), Some("1.0.0"));
    assert!(!installed.update_available);
    let state = market::load_state(&paths.state_file);
    let rec = state.items.get(SKILL_ID).expect("recorded");
    let skill_dir = rec.skill_dir.clone().expect("skill dir");
    let ssot = SkillService::get_ssot_dir().unwrap().join(&skill_dir);
    assert!(ssot.starts_with(&home), "{}", ssot.display());
    assert!(ssot.join("SKILL.md").is_file() && ssot.join("notes.txt").is_file());
    let skill_id = rec.skill_id.clone().expect("skill id");
    assert!(db.get_installed_skill(&skill_id).unwrap().is_some());
    let codex_skills = SkillService::get_app_skills_dir(&AppType::Codex).unwrap();
    assert!(codex_skills.starts_with(&home));
    assert!(
        codex_skills.join(&skill_dir).join("SKILL.md").exists(),
        "skill enabled for Codex"
    );
    let entries = market::list(&session, &db, &paths).await.unwrap();
    let listed = entries.iter().find(|e| e.item.id == SKILL_ID).unwrap();
    assert_eq!(listed.installed_version.as_deref(), Some("1.0.0"));
    market::uninstall(&session, &db, &paths, SKILL_ID)
        .await
        .expect("uninstall");
    assert!(db.get_installed_skill(&skill_id).unwrap().is_none());
    // Mandatory items cannot be uninstalled.
    let err = market::uninstall(&session, &db, &paths, PLUGIN_ID)
        .await
        .expect_err("mandatory");
    assert!(err.contains("Mandatory"), "{err}");
    eprintln!("[e2e-mkt] skill installed as {skill_dir} and removed; all steps passed");
    session.logout().await;
}

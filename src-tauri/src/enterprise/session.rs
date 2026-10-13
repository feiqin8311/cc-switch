//! Enterprise session: owns the refresh token (on disk, 0600) and the access
//! token (memory only). Tokens never leave this module except through
//! [`EnterpriseSession::access_token`] for Rust-side callers.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::client::{self, ApiClient, EnterpriseError};
use super::server_url::normalize_server_url;
use super::types::{
    ClientConfigResponse, EnterpriseState, GatewayKeyResponse, LoginRequest, ManagedProvider,
    RefreshRequest, SessionResponse, User,
};

pub const SESSION_FILE_NAME: &str = "enterprise_session.json";

/// Refresh the access token this long before it expires.
const ACCESS_TOKEN_SKEW_SECS: i64 = 30;
const MAX_DEVICE_NAME_CHARS: usize = 100;
const SESSION_EXPIRED_MESSAGE: &str = "Session expired, please sign in again";
/// Permission needed to use the model gateway.
pub const MODELS_USE_PERMISSION: &str = "models.use";

/// Something about the signed-in session changed (config fetched, logged out,
/// session cleared after a rejected refresh). Listeners re-read the state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEvent {
    ConfigUpdated,
    Cleared,
}

pub type SessionListener = Arc<dyn Fn(SessionEvent) + Send + Sync>;

/// What the managed-provider sync needs from the session. No secrets.
#[derive(Debug, Clone, PartialEq)]
pub struct ManagedProvidersSnapshot {
    pub server_url: String,
    pub permissions: Vec<String>,
    pub providers: Vec<ManagedProvider>,
}

impl ManagedProvidersSnapshot {
    /// The user may use the gateway and the server offers at least one provider.
    pub fn wants_gateway(&self) -> bool {
        self.permissions.iter().any(|p| p == MODELS_USE_PERMISSION) && !self.providers.is_empty()
    }
}

/// Gateway key of the current login session (`POST /client/gateway-key`).
/// A secret: no `Debug`, persisted only in the 0600 session file.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredGatewayKey {
    key: String,
    #[serde(default)]
    created_at: Option<String>,
}

/// On-disk session (`enterprise_session.json`). Contains the refresh token:
/// intentionally no `Debug`.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    #[serde(default)]
    server_url: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    refresh_token_expires_at: Option<String>,
    #[serde(default)]
    user: Option<User>,
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(default)]
    last_config: Option<ClientConfigResponse>,
    /// Dies with the login session: cleared on logout / new login / expiry.
    #[serde(default)]
    gateway_key: Option<StoredGatewayKey>,
}

impl StoredSession {
    fn is_logged_in(&self) -> bool {
        self.server_url.is_some()
            && self.refresh_token.as_deref().is_some_and(|t| !t.is_empty())
            && !is_expired(self.refresh_token_expires_at.as_deref(), 0)
    }

    /// Drop everything user-scoped; keep `server_url`.
    fn clear_auth(&mut self) {
        self.refresh_token = None;
        self.refresh_token_expires_at = None;
        self.user = None;
        self.permissions.clear();
        self.last_config = None;
        self.gateway_key = None;
    }
}

struct AccessToken {
    token: String,
    expires_at: Option<String>,
}

impl AccessToken {
    fn is_fresh(&self) -> bool {
        !is_expired(self.expires_at.as_deref(), ACCESS_TOKEN_SKEW_SECS)
    }
}

struct Inner {
    stored: StoredSession,
    access: Option<AccessToken>,
    offline: bool,
    last_error: Option<String>,
    /// Bumped whenever the login session is replaced or cleared, so results of
    /// requests started under an older session are dropped.
    generation: u64,
}

impl Inner {
    fn snapshot(&self) -> EnterpriseState {
        let logged_in = self.stored.is_logged_in();
        EnterpriseState {
            server_url: self.stored.server_url.clone(),
            logged_in,
            offline: logged_in && self.offline,
            user: if logged_in {
                self.stored.user.clone()
            } else {
                None
            },
            permissions: if logged_in {
                self.stored.permissions.clone()
            } else {
                Vec::new()
            },
            config: if logged_in {
                self.stored.last_config.clone()
            } else {
                None
            },
            last_error: self.last_error.clone(),
        }
    }

    fn apply_session(&mut self, server_url: String, s: SessionResponse) {
        let same_account = self.stored.server_url.as_deref() == Some(server_url.as_str())
            && self.stored.user.as_ref().map(|u| &u.id) == Some(&s.user.id);
        if !same_account {
            self.stored.last_config = None;
        }
        self.stored.server_url = Some(server_url);
        self.stored.refresh_token = Some(s.refresh_token);
        self.stored.refresh_token_expires_at = Some(s.refresh_token_expires_at);
        self.stored.user = Some(s.user);
        self.stored.permissions = s.permissions;
        self.access = Some(AccessToken {
            token: s.access_token,
            expires_at: Some(s.access_token_expires_at),
        });
        self.offline = false;
        self.last_error = None;
    }

    /// Update `offline` / `last_error` from the outcome of a server call.
    fn note_outcome<T>(&mut self, result: &Result<T, EnterpriseError>) {
        match result {
            Ok(_) => {
                self.offline = false;
                self.last_error = None;
            }
            Err(e) => {
                // Any HTTP response (even an error) proves the server is reachable.
                self.offline = e.is_network();
                self.last_error = Some(e.to_string());
            }
        }
    }
}

/// The enterprise session. Managed as Tauri state via
/// `commands::EnterpriseSessionState`.
pub struct EnterpriseSession {
    api: ApiClient,
    storage_path: PathBuf,
    inner: Mutex<Inner>,
    /// Serializes refresh / login / logout so a rotating refresh token is never
    /// used twice. Lock order: `auth_lock` before `inner`; `inner` is never held
    /// across network calls.
    auth_lock: Mutex<()>,
    /// Notified (outside all locks) when the session / config changes.
    listener: OnceLock<SessionListener>,
}

impl EnterpriseSession {
    /// `config_dir` is the app config dir (`crate::config::get_app_config_dir()`).
    pub fn new(config_dir: PathBuf) -> Self {
        let storage_path = config_dir.join(SESSION_FILE_NAME);
        let stored = load_stored(&storage_path);
        Self {
            api: ApiClient::new(),
            storage_path,
            inner: Mutex::new(Inner {
                stored,
                access: None,
                offline: false,
                last_error: None,
                generation: 0,
            }),
            auth_lock: Mutex::new(()),
            listener: OnceLock::new(),
        }
    }

    /// Install the session listener (once; later calls are ignored).
    pub fn set_listener(&self, listener: SessionListener) {
        if self.listener.set(listener).is_err() {
            log::warn!("[Enterprise] session listener already installed");
        }
    }

    fn notify(&self, event: SessionEvent) {
        if let Some(listener) = self.listener.get() {
            listener(event);
        }
    }

    /// Server URL, permissions and managed providers of the signed-in session
    /// (from the cached config). `None` when not signed in.
    pub async fn managed_providers_snapshot(&self) -> Option<ManagedProvidersSnapshot> {
        let inner = self.inner.lock().await;
        if !inner.stored.is_logged_in() {
            return None;
        }
        Some(ManagedProvidersSnapshot {
            server_url: inner.stored.server_url.clone()?,
            permissions: inner.stored.permissions.clone(),
            providers: inner
                .stored
                .last_config
                .as_ref()
                .map(|c| c.providers.clone())
                .unwrap_or_default(),
        })
    }

    /// The gateway key of the current login session, requesting one
    /// (`POST /client/gateway-key`) the first time. Returns the server URL it
    /// belongs to and the key. Rust-side only: never put it in `EnterpriseState`.
    pub async fn ensure_gateway_key(&self) -> Result<(String, String), EnterpriseError> {
        let generation = {
            let inner = self.inner.lock().await;
            if !inner.stored.is_logged_in() {
                return Err(EnterpriseError::NotLoggedIn);
            }
            if let (Some(base), Some(stored)) =
                (&inner.stored.server_url, &inner.stored.gateway_key)
            {
                if !stored.key.is_empty() {
                    return Ok((base.clone(), stored.key.clone()));
                }
            }
            inner.generation
        };

        let (base, resp) = self
            .send_authenticated(|http, base, token| {
                http.post(client::endpoint(base, "/client/gateway-key"))
                    .bearer_auth(token)
                    .json(&serde_json::json!({}))
            })
            .await?;
        let issued = client::decode_json::<GatewayKeyResponse>(resp).await?;
        if issued.key.trim().is_empty() {
            return Err(EnterpriseError::InvalidResponse(
                "Empty gateway key".to_string(),
            ));
        }

        let mut inner = self.inner.lock().await;
        // A login / logout happened meanwhile: the key belongs to a dead session.
        if inner.generation != generation
            || !inner.stored.is_logged_in()
            || inner.stored.server_url.as_deref() != Some(base.as_str())
        {
            return Err(EnterpriseError::NotLoggedIn);
        }
        inner.stored.gateway_key = Some(StoredGatewayKey {
            key: issued.key.clone(),
            created_at: issued.created_at,
        });
        let stored = inner.stored.clone();
        if let Err(e) = self.persist(&stored) {
            inner.last_error = Some(e.to_string());
        }
        Ok((base, issued.key))
    }

    /// Current state for the UI. No network.
    pub async fn state(&self) -> EnterpriseState {
        self.inner.lock().await.snapshot()
    }

    /// Normalized URL of the configured server, if any.
    #[allow(dead_code)] // public API for later enterprise features (audit upload, marketplace)
    pub async fn server_url(&self) -> Option<String> {
        self.inner.lock().await.stored.server_url.clone()
    }

    /// The shared HTTP client (15 s timeout, no redirects).
    #[allow(dead_code)] // public API for later enterprise features
    pub fn http(&self) -> &reqwest::Client {
        self.api.http()
    }

    /// A valid access token, refreshing it if needed.
    #[allow(dead_code)] // public API for later enterprise features
    pub async fn access_token(&self) -> Result<String, EnterpriseError> {
        self.access_with_base().await.map(|(_, token)| token)
    }

    /// Log in, replacing any previous session on success.
    pub async fn login(
        &self,
        server_url: &str,
        username: &str,
        password: &str,
    ) -> Result<EnterpriseState, EnterpriseError> {
        let base = normalize_server_url(server_url).map_err(EnterpriseError::InvalidServerUrl)?;
        let username = username.trim();
        if username.is_empty() || password.is_empty() {
            return Err(EnterpriseError::InvalidInput(
                "Username and password are required".to_string(),
            ));
        }
        let device_name = device_name();

        let previous = {
            let _auth = self.auth_lock.lock().await;
            let result = self
                .api
                .post_json::<_, SessionResponse>(
                    &base,
                    "/auth/login",
                    &LoginRequest {
                        username,
                        password,
                        device_name: Some(&device_name),
                    },
                )
                .await;

            let mut inner = self.inner.lock().await;
            let session = match result {
                Ok(s) => s,
                Err(e) => {
                    inner.last_error = Some(e.to_string());
                    return Err(e);
                }
            };
            let previous = inner
                .stored
                .server_url
                .clone()
                .zip(inner.stored.refresh_token.clone());
            inner.apply_session(base.clone(), session);
            // New login session: the old gateway key died with the old session.
            inner.stored.gateway_key = None;
            inner.generation += 1;
            let stored = inner.stored.clone();
            if let Err(e) = self.persist(&stored) {
                inner.last_error = Some(e.to_string());
            }
            previous
        };

        // Best-effort revoke of the session we just replaced.
        if let Some((old_base, old_token)) = previous {
            self.spawn_server_logout(old_base, old_token);
        }

        // Best-effort: fetch the client config right away; failures end up in lastError.
        // A successful fetch notifies listeners itself; otherwise notify here so
        // the new session (new gateway key) is still picked up from the cache.
        if self.fetch_config().await.is_err() {
            self.notify(SessionEvent::ConfigUpdated);
        }
        Ok(self.state().await)
    }

    /// Clear the local session (always) and revoke it on the server (best-effort,
    /// in the background). Keeps `serverUrl`.
    pub async fn logout(&self) -> EnterpriseState {
        let _auth = self.auth_lock.lock().await;
        let mut inner = self.inner.lock().await;
        let revoke = inner
            .stored
            .server_url
            .clone()
            .zip(inner.stored.refresh_token.clone());
        inner.stored.clear_auth();
        inner.generation += 1;
        inner.access = None;
        inner.offline = false;
        inner.last_error = None;
        let stored = inner.stored.clone();
        if let Err(e) = self.persist(&stored) {
            inner.last_error = Some(e.to_string());
        }
        let state = inner.snapshot();
        drop(inner);

        if let Some((base, token)) = revoke {
            self.spawn_server_logout(base, token);
        }
        self.notify(SessionEvent::Cleared);
        state
    }

    /// `GET /client/config`, updating the cached config / user / permissions.
    /// Network / server failures are reported via `lastError` (and `offline`),
    /// the cached config is kept. Errors only when not logged in.
    pub async fn refresh_config(&self) -> Result<EnterpriseState, EnterpriseError> {
        match self.fetch_config().await {
            Err(EnterpriseError::NotLoggedIn) => Err(EnterpriseError::NotLoggedIn),
            _ => Ok(self.state().await),
        }
    }

    async fn fetch_config(&self) -> Result<(), EnterpriseError> {
        let (base, config) = self
            .get_json_with_base::<ClientConfigResponse>("/client/config")
            .await?;
        let mut inner = self.inner.lock().await;
        // Ignore the result if the session changed while the request was in flight.
        if !inner.stored.is_logged_in() || inner.stored.server_url.as_deref() != Some(&base) {
            return Ok(());
        }
        inner.stored.user = Some(config.user.clone());
        inner.stored.permissions = config.permissions.clone();
        inner.stored.last_config = Some(config);
        let stored = inner.stored.clone();
        if let Err(e) = self.persist(&stored) {
            inner.last_error = Some(e.to_string());
        }
        drop(inner);
        self.notify(SessionEvent::ConfigUpdated);
        Ok(())
    }

    /// Authenticated `GET {server}/api/v1{path}` decoding JSON, with one
    /// refresh-and-retry on 401.
    #[allow(dead_code)] // public API for later enterprise features
    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, EnterpriseError> {
        self.get_json_with_base(path).await.map(|(_, v)| v)
    }

    async fn get_json_with_base<T: DeserializeOwned>(
        &self,
        path: &str,
    ) -> Result<(String, T), EnterpriseError> {
        let (base, resp) = self
            .send_authenticated(|http, base, token| {
                http.get(client::endpoint(base, path)).bearer_auth(token)
            })
            .await?;
        let value = client::decode_json::<T>(resp).await;
        self.inner.lock().await.note_outcome(&value);
        value.map(|v| (base, v))
    }

    /// Send an authenticated request built by `build(http, server_url, access_token)`.
    /// On 401: refresh once and retry once. If the refresh itself gets a 401 the
    /// session is cleared (logged out, `serverUrl` kept). Network errors mark the
    /// session offline and keep it. Returns the server URL used and the 2xx response.
    pub async fn send_authenticated<F>(
        &self,
        build: F,
    ) -> Result<(String, reqwest::Response), EnterpriseError>
    where
        F: Fn(&reqwest::Client, &str, &str) -> reqwest::RequestBuilder,
    {
        let (base, token) = self.access_with_base().await?;
        let first = self.send_once(&build, &base, &token).await;
        let result = match first {
            Err(EnterpriseError::Unauthorized(_)) => {
                let (base, token) = self.refresh_access_token(Some(&token)).await?;
                self.send_once(&build, &base, &token)
                    .await
                    .map(|resp| (base, resp))
            }
            other => other.map(|resp| (base, resp)),
        };
        let mut inner = self.inner.lock().await;
        if result.is_ok() {
            inner.offline = false;
        } else {
            inner.note_outcome(&result);
        }
        drop(inner);
        result
    }

    async fn send_once<F>(
        &self,
        build: &F,
        base: &str,
        token: &str,
    ) -> Result<reqwest::Response, EnterpriseError>
    where
        F: Fn(&reqwest::Client, &str, &str) -> reqwest::RequestBuilder,
    {
        let resp = client::send(build(self.api.http(), base, token)).await?;
        client::check_status(resp).await
    }

    async fn access_with_base(&self) -> Result<(String, String), EnterpriseError> {
        {
            let inner = self.inner.lock().await;
            if !inner.stored.is_logged_in() {
                return Err(EnterpriseError::NotLoggedIn);
            }
            if let (Some(base), Some(access)) = (&inner.stored.server_url, &inner.access) {
                if access.is_fresh() {
                    return Ok((base.clone(), access.token.clone()));
                }
            }
        }
        self.refresh_access_token(None).await
    }

    /// Rotate the refresh token. `rejected` is the access token that just got a
    /// 401; if another task already replaced it, the new one is returned without
    /// a second refresh.
    async fn refresh_access_token(
        &self,
        rejected: Option<&str>,
    ) -> Result<(String, String), EnterpriseError> {
        let _auth = self.auth_lock.lock().await;

        let (base, refresh_token) = {
            let inner = self.inner.lock().await;
            if !inner.stored.is_logged_in() {
                return Err(EnterpriseError::NotLoggedIn);
            }
            let (Some(base), Some(refresh_token)) = (
                inner.stored.server_url.clone(),
                inner.stored.refresh_token.clone(),
            ) else {
                return Err(EnterpriseError::NotLoggedIn);
            };
            if let Some(access) = &inner.access {
                if access.is_fresh() && Some(access.token.as_str()) != rejected {
                    return Ok((base, access.token.clone()));
                }
            }
            (base, refresh_token)
        };

        let result = self
            .api
            .post_json::<_, SessionResponse>(
                &base,
                "/auth/refresh",
                &RefreshRequest {
                    refresh_token: &refresh_token,
                },
            )
            .await;

        let mut inner = self.inner.lock().await;
        match result {
            Ok(session) => {
                let token = session.access_token.clone();
                inner.apply_session(base.clone(), session);
                let stored = inner.stored.clone();
                if let Err(e) = self.persist(&stored) {
                    inner.last_error = Some(e.to_string());
                }
                Ok((base, token))
            }
            Err(e) if e.is_unauthorized() => {
                log::info!("[Enterprise] refresh rejected, clearing session");
                inner.stored.clear_auth();
                inner.generation += 1;
                inner.access = None;
                inner.offline = false;
                inner.last_error = Some(SESSION_EXPIRED_MESSAGE.to_string());
                let stored = inner.stored.clone();
                if let Err(err) = self.persist(&stored) {
                    log::error!("[Enterprise] {err}");
                }
                drop(inner);
                self.notify(SessionEvent::Cleared);
                Err(EnterpriseError::Unauthorized(
                    SESSION_EXPIRED_MESSAGE.to_string(),
                ))
            }
            Err(e) => {
                inner.note_outcome::<()>(&Err(e.clone()));
                Err(e)
            }
        }
    }

    fn spawn_server_logout(&self, base: String, refresh_token: String) {
        let api = self.api.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = api
                .post_no_content(
                    &base,
                    "/auth/logout",
                    &RefreshRequest {
                        refresh_token: &refresh_token,
                    },
                )
                .await
            {
                log::warn!("[Enterprise] server logout failed: {e}");
            }
        });
    }

    fn persist(&self, stored: &StoredSession) -> Result<(), EnterpriseError> {
        crate::config::write_json_file_private(&self.storage_path, stored).map_err(|e| {
            log::error!("[Enterprise] failed to save session: {e}");
            EnterpriseError::Storage("Failed to save the enterprise session".to_string())
        })
    }

    /// Test-only: drop the in-memory access token so the next call must refresh.
    #[cfg(test)]
    pub(crate) async fn forget_access_token_for_test(&self) {
        self.inner.lock().await.access = None;
    }
}

fn load_stored(path: &Path) -> StoredSession {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return StoredSession::default(),
        Err(e) => {
            log::warn!("[Enterprise] failed to read session file: {e}");
            return StoredSession::default();
        }
    };
    let mut stored: StoredSession = match serde_json::from_str(&content) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[Enterprise] invalid session file, ignoring: {e}");
            return StoredSession::default();
        }
    };
    // Re-validate a hand-edited server URL; drop it (and the session) if invalid.
    if let Some(url) = stored.server_url.take() {
        match normalize_server_url(&url) {
            Ok(url) => stored.server_url = Some(url),
            Err(_) => {
                log::warn!("[Enterprise] stored server URL is invalid, ignoring session");
                return StoredSession::default();
            }
        }
    }
    if !stored.is_logged_in() {
        stored.clear_auth();
    }
    stored
}

/// `true` when `ts` (RFC 3339) is at or before now + `skew_secs`.
/// Missing / unparsable timestamps are treated as not expired (the server decides).
fn is_expired(ts: Option<&str>, skew_secs: i64) -> bool {
    let Some(ts) = ts else {
        return false;
    };
    match DateTime::parse_from_rfc3339(ts) {
        Ok(t) => t.with_timezone(&Utc) <= Utc::now() + ChronoDuration::seconds(skew_secs),
        Err(_) => false,
    }
}

/// `"<hostname> (CC Switch <version>)"`, at most 100 chars.
fn device_name() -> String {
    let host = hostname().unwrap_or_else(|| "Unknown device".to_string());
    let name = format!("{host} (CC Switch {})", env!("CARGO_PKG_VERSION"));
    name.chars().take(MAX_DEVICE_NAME_CHARS).collect()
}

fn hostname() -> Option<String> {
    let from_env = ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .map(|v| v.trim().to_string())
        .find(|v| !v.is_empty());
    if from_env.is_some() {
        return from_env;
    }
    #[cfg(unix)]
    {
        if let Ok(out) = std::process::Command::new("hostname").output() {
            if out.status.success() {
                let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !name.is_empty() {
                    return Some(name);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_user() -> User {
        User {
            id: "00000000-0000-0000-0000-000000000001".into(),
            username: "alice".into(),
            display_name: "Alice".into(),
            role: "member".into(),
            disabled: false,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            last_login_at: None,
        }
    }

    fn sample_session(access: &str, refresh: &str) -> SessionResponse {
        SessionResponse {
            access_token: access.into(),
            access_token_expires_at: "2999-01-01T00:00:00.000Z".into(),
            refresh_token: refresh.into(),
            refresh_token_expires_at: "2999-01-01T00:00:00.000Z".into(),
            user: sample_user(),
            permissions: vec!["models.use".into(), "market.install".into()],
        }
    }

    fn new_inner() -> Inner {
        Inner {
            stored: StoredSession::default(),
            access: None,
            offline: false,
            last_error: None,
            generation: 0,
        }
    }

    #[test]
    fn state_serialization_has_no_tokens() {
        let mut inner = new_inner();
        inner.apply_session(
            "https://ent.example.com".into(),
            sample_session("ACCESS-SECRET-123", "REFRESH-SECRET-456"),
        );
        let state = inner.snapshot();
        assert!(state.logged_in);
        let json = serde_json::to_string(&state).unwrap();
        assert!(!json.contains("ACCESS-SECRET-123"));
        assert!(!json.contains("REFRESH-SECRET-456"));
        let lower = json.to_lowercase();
        assert!(
            !lower.contains("token"),
            "state JSON leaks token field: {json}"
        );

        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str())
            .collect();
        for k in [
            "serverUrl",
            "loggedIn",
            "offline",
            "user",
            "permissions",
            "config",
            "lastError",
        ] {
            assert!(keys.contains(&k), "missing key {k} in {json}");
        }
        assert_eq!(keys.len(), 7);
        assert_eq!(value["user"]["displayName"], "Alice");
    }

    #[test]
    fn stored_session_roundtrip_and_clear_keeps_server_url() {
        let mut inner = new_inner();
        inner.apply_session("https://ent.example.com".into(), sample_session("a", "r"));
        let json = serde_json::to_string(&inner.stored).unwrap();
        assert!(json.contains("\"refreshToken\":\"r\""));
        assert!(json.contains("\"serverUrl\""));
        assert!(
            !json.contains("accessToken"),
            "access token must not be persisted"
        );

        inner.stored.clear_auth();
        inner.access = None;
        let state = inner.snapshot();
        assert!(!state.logged_in);
        assert_eq!(state.server_url.as_deref(), Some("https://ent.example.com"));
        assert!(state.user.is_none());
        assert!(state.permissions.is_empty());
    }

    #[test]
    fn expiry_parsing() {
        assert!(!is_expired(None, 0));
        assert!(!is_expired(Some("garbage"), 0));
        assert!(is_expired(Some("2000-01-01T00:00:00.000Z"), 0));
        assert!(!is_expired(Some("2999-01-01T00:00:00Z"), 30));
    }

    #[test]
    fn expired_refresh_token_is_logged_out() {
        let mut stored = StoredSession {
            server_url: Some("https://ent.example.com".into()),
            refresh_token: Some("r".into()),
            refresh_token_expires_at: Some("2000-01-01T00:00:00Z".into()),
            ..Default::default()
        };
        assert!(!stored.is_logged_in());
        stored.refresh_token_expires_at = Some("2999-01-01T00:00:00Z".into());
        assert!(stored.is_logged_in());
    }

    #[test]
    fn load_and_persist_file() {
        let dir = tempfile::tempdir().unwrap();
        let session = EnterpriseSession::new(dir.path().to_path_buf());
        let mut stored = StoredSession {
            server_url: Some("https://ent.example.com/".into()),
            refresh_token: Some("r".into()),
            refresh_token_expires_at: Some("2999-01-01T00:00:00Z".into()),
            user: Some(sample_user()),
            ..Default::default()
        };
        session.persist(&stored).unwrap();
        let path = dir.path().join(SESSION_FILE_NAME);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let loaded = load_stored(&path);
        assert!(loaded.is_logged_in());
        assert_eq!(
            loaded.server_url.as_deref(),
            Some("https://ent.example.com")
        );

        stored.refresh_token_expires_at = Some("2000-01-01T00:00:00Z".into());
        session.persist(&stored).unwrap();
        let loaded = load_stored(&path);
        assert!(!loaded.is_logged_in());
        assert!(loaded.refresh_token.is_none());
        assert!(loaded.user.is_none());
    }

    #[test]
    fn gateway_key_is_persisted_privately_but_never_in_state() {
        let mut inner = new_inner();
        inner.apply_session("https://ent.example.com".into(), sample_session("a", "r"));
        inner.stored.gateway_key = Some(StoredGatewayKey {
            key: "gk_SECRET-789".into(),
            created_at: None,
        });
        let state_json = serde_json::to_string(&inner.snapshot()).unwrap();
        assert!(!state_json.contains("gk_SECRET-789"));
        let stored_json = serde_json::to_string(&inner.stored).unwrap();
        assert!(stored_json.contains("\"gatewayKey\""));

        inner.stored.clear_auth();
        assert!(inner.stored.gateway_key.is_none());
    }

    #[test]
    fn snapshot_wants_gateway_needs_permission_and_providers() {
        let provider: ManagedProvider =
            serde_json::from_value(serde_json::json!({ "id": "p" })).unwrap();
        let mut snapshot = ManagedProvidersSnapshot {
            server_url: "https://ent.example.com".into(),
            permissions: vec![MODELS_USE_PERMISSION.into()],
            providers: vec![provider],
        };
        assert!(snapshot.wants_gateway());
        snapshot.permissions.clear();
        assert!(!snapshot.wants_gateway());
        snapshot.permissions = vec![MODELS_USE_PERMISSION.into()];
        snapshot.providers.clear();
        assert!(!snapshot.wants_gateway());
    }

    #[test]
    fn device_name_is_bounded() {
        let name = device_name();
        assert!(name.contains("(CC Switch "));
        assert!(name.chars().count() <= MAX_DEVICE_NAME_CHARS);
    }
}

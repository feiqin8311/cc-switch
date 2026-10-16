//! Serde types mirroring the enterprise API contract
//! (`enterprise/contracts/src/index.ts`). JSON fields are camelCase.
//!
//! Types that carry tokens (`SessionResponse`, `RefreshRequest`, `LoginRequest`)
//! intentionally do not derive `Debug`/`Serialize` beyond what the wire needs,
//! so they cannot end up in logs or in the webview by accident.

use serde::{Deserialize, Serialize};

/// Role is one of `admin | member | viewer`; kept as a string for forward compatibility.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub disabled: bool,
    pub created_at: String,
    pub last_login_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedModel {
    pub id: String,
    #[serde(default)]
    pub display_name: String,
}

fn default_kind() -> String {
    "gateway".to_string()
}

fn default_wire_api() -> String {
    "responses".to_string()
}

/// A model provider the enterprise server offers to this user. Requests go
/// through the server's gateway (`<serverUrl><gatewayPath>`, OpenAI Responses
/// API, `Authorization: Bearer <gateway key>`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProvider {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Currently always `gateway`.
    #[serde(default = "default_kind")]
    pub kind: String,
    /// e.g. `/gateway/openai-main/v1`.
    #[serde(default)]
    pub gateway_path: String,
    /// Currently always `responses`.
    #[serde(default = "default_wire_api")]
    pub wire_api: String,
    #[serde(default)]
    pub models: Vec<ManagedModel>,
    #[serde(default)]
    pub default_model: String,
    #[serde(default)]
    pub daily_token_limit: Option<u64>,
    #[serde(default)]
    pub used_tokens_today: u64,
}

/// `POST /client/gateway-key`. Contains a secret: no `Debug`, no `Serialize`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GatewayKeyResponse {
    pub key: String,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetentionPolicy {
    /// While true this device syncs all its Codex sessions once a day.
    pub enabled: bool,
}

/// `GET /client/config`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfigResponse {
    pub user: User,
    pub permissions: Vec<String>,
    pub providers: Vec<ManagedProvider>,
    pub retention: RetentionPolicy,
    pub server_time: String,
}

/// Response of `POST /auth/login` and `POST /auth/refresh`. Contains secrets:
/// no `Debug`, no `Serialize`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionResponse {
    pub access_token: String,
    pub access_token_expires_at: String,
    pub refresh_token: String,
    pub refresh_token_expires_at: String,
    pub user: User,
    pub permissions: Vec<String>,
}

/// `POST /auth/login`
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginRequest<'a> {
    pub username: &'a str,
    pub password: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<&'a str>,
}

/// `POST /auth/refresh` and `POST /auth/logout`
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefreshRequest<'a> {
    pub refresh_token: &'a str,
}

/// Every non-2xx response: `{ "error": { "code", "message" } }`.
#[derive(Deserialize)]
pub(crate) struct ErrorResponse {
    pub error: ErrorBody,
}

#[derive(Deserialize)]
pub(crate) struct ErrorBody {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

/// State exposed to the webview. Never contains tokens.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnterpriseState {
    pub server_url: Option<String>,
    pub logged_in: bool,
    pub offline: bool,
    pub user: Option<User>,
    pub permissions: Vec<String>,
    pub config: Option<ClientConfigResponse>,
    pub last_error: Option<String>,
}

/// `meta.enterprise` of a Codex provider card managed by the enterprise server
/// (see `enterprise::providers`). Not a secret: the gateway key lives in the
/// card's `settings_config.auth`, like any other API key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnterpriseProviderMeta {
    pub server_url: String,
    pub provider_id: String,
    /// Models the user may pick for this card (the gateway rejects others).
    #[serde(default)]
    pub models: Vec<ManagedModel>,
}

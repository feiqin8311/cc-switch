//! Low-level HTTP client for the enterprise server.
//!
//! - one shared `reqwest::Client`, 15 s timeout
//! - redirects are NOT followed, so credentials / bearer tokens are never sent
//!   to a host other than the configured server
//! - response bodies are read with a size cap
//! - error messages never contain tokens or passwords

use std::fmt;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Serialize;

use super::types::ErrorResponse;

pub const API_PREFIX: &str = "/api/v1";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Upper bound for any JSON body we accept from the server.
const MAX_JSON_BODY_BYTES: usize = 4 * 1024 * 1024;
/// Upper bound for error bodies (only `{error:{code,message}}` is expected).
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

/// Errors of the enterprise module. `Display` is the short, user-facing message.
#[derive(Debug, Clone, PartialEq)]
pub enum EnterpriseError {
    /// No session (never logged in, logged out, or refresh token expired).
    NotLoggedIn,
    InvalidServerUrl(String),
    InvalidInput(String),
    /// The server could not be reached (connect error, timeout, broken body).
    /// The stored session is kept: the client is "offline".
    Network(String),
    /// HTTP 401. Carries the server's message (or a default one).
    Unauthorized(String),
    /// Any other non-2xx response.
    Api {
        status: u16,
        code: Option<String>,
        message: String,
    },
    /// 2xx but the body is not what the contract says.
    InvalidResponse(String),
    Storage(String),
}

impl EnterpriseError {
    pub fn is_network(&self) -> bool {
        matches!(self, Self::Network(_))
    }

    pub fn is_unauthorized(&self) -> bool {
        matches!(self, Self::Unauthorized(_))
    }

    /// Server error code (`bad_request`, `forbidden`, ...), when known.
    #[allow(dead_code)] // public API for later enterprise features
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Unauthorized(_) => Some("unauthorized"),
            Self::Api { code, .. } => code.as_deref(),
            _ => None,
        }
    }
}

impl fmt::Display for EnterpriseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotLoggedIn => f.write_str("Not signed in to the enterprise server"),
            Self::InvalidServerUrl(m)
            | Self::InvalidInput(m)
            | Self::Network(m)
            | Self::Unauthorized(m)
            | Self::InvalidResponse(m)
            | Self::Storage(m) => f.write_str(m),
            Self::Api { message, .. } => f.write_str(message),
        }
    }
}

impl std::error::Error for EnterpriseError {}

impl From<EnterpriseError> for String {
    fn from(e: EnterpriseError) -> Self {
        e.to_string()
    }
}

/// Build `"{base}/api/v1{path}"`. `base` is a normalized server URL (no trailing `/`),
/// `path` starts with `/`.
pub fn endpoint(base: &str, path: &str) -> String {
    format!("{base}{API_PREFIX}{path}")
}

#[derive(Clone)]
pub struct ApiClient {
    http: reqwest::Client,
}

impl ApiClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("CC-Switch/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|e| {
                log::error!("[Enterprise] failed to build HTTP client: {e}");
                reqwest::Client::new()
            });
        Self { http }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// `POST` a JSON body without authentication and decode a JSON response.
    pub async fn post_json<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        base: &str,
        path: &str,
        body: &B,
    ) -> Result<T, EnterpriseError> {
        let resp = send(self.http.post(endpoint(base, path)).json(body)).await?;
        let resp = check_status(resp).await?;
        decode_json(resp).await
    }

    /// `POST` a JSON body without authentication, ignoring the (2xx) response body.
    pub async fn post_no_content<B: Serialize + ?Sized>(
        &self,
        base: &str,
        path: &str,
        body: &B,
    ) -> Result<(), EnterpriseError> {
        let resp = send(self.http.post(endpoint(base, path)).json(body)).await?;
        check_status(resp).await.map(|_| ())
    }
}

/// Send a request, mapping transport failures to [`EnterpriseError::Network`].
pub async fn send(rb: reqwest::RequestBuilder) -> Result<reqwest::Response, EnterpriseError> {
    rb.send().await.map_err(network_error)
}

/// Pass 2xx responses through; turn anything else into an [`EnterpriseError`]
/// using the server's `error.message` when present.
pub async fn check_status(resp: reqwest::Response) -> Result<reqwest::Response, EnterpriseError> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }

    let body = read_body_limited(resp, MAX_ERROR_BODY_BYTES)
        .await
        .unwrap_or_default();
    let parsed = serde_json::from_slice::<ErrorResponse>(&body).ok();
    let (code, message) = match parsed {
        Some(r) => (
            r.error.code,
            r.error.message.filter(|m| !m.trim().is_empty()),
        ),
        None => (None, None),
    };

    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(EnterpriseError::Unauthorized(
            message.unwrap_or_else(|| "Authentication failed".to_string()),
        ));
    }

    let message = message.unwrap_or_else(|| {
        if status.is_redirection() {
            "Unexpected redirect from the enterprise server".to_string()
        } else {
            format!("Enterprise server returned HTTP {}", status.as_u16())
        }
    });
    Err(EnterpriseError::Api {
        status: status.as_u16(),
        code,
        message,
    })
}

/// Decode a 2xx JSON body (size-capped).
pub async fn decode_json<T: DeserializeOwned>(
    resp: reqwest::Response,
) -> Result<T, EnterpriseError> {
    let body = read_body_limited(resp, MAX_JSON_BODY_BYTES).await?;
    serde_json::from_slice(&body).map_err(|e| {
        log::warn!("[Enterprise] unexpected response body: {e}");
        EnterpriseError::InvalidResponse("Unexpected response from the enterprise server".into())
    })
}

/// Read a response body chunk by chunk, refusing to buffer more than `limit` bytes.
async fn read_body_limited(
    mut resp: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, EnterpriseError> {
    if let Some(len) = resp.content_length() {
        if len as usize > limit {
            return Err(EnterpriseError::InvalidResponse(
                "Response from the enterprise server is too large".into(),
            ));
        }
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(network_error)? {
        if buf.len() + chunk.len() > limit {
            return Err(EnterpriseError::InvalidResponse(
                "Response from the enterprise server is too large".into(),
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

fn network_error(e: reqwest::Error) -> EnterpriseError {
    // Log without the URL path details being user-facing; tokens are never in URLs.
    log::warn!("[Enterprise] network error: {e}");
    let msg = if e.is_timeout() {
        "Request to the enterprise server timed out"
    } else if e.is_connect() {
        "Cannot connect to the enterprise server"
    } else {
        "Network error while contacting the enterprise server"
    };
    EnterpriseError::Network(msg.to_string())
}

//! End-to-end test against a REAL enterprise server. Ignored by default.
//!
//! ```sh
//! CCSE_E2E_SERVER=http://127.0.0.1:4200 CCSE_E2E_PASSWORD=... \
//!   cargo test --lib enterprise -- --ignored --nocapture
//! ```
//! Uses user `admin` (override with `CCSE_E2E_USER`). Only ONE wrong-password
//! attempt is made (the server rate-limits failed logins).

use std::path::Path;
use std::time::Duration;

use super::client::endpoint;
use super::session::{EnterpriseSession, SESSION_FILE_NAME};

fn stored_refresh_token(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).expect("session file readable");
    let v: serde_json::Value = serde_json::from_str(&raw).expect("session file is JSON");
    v.get("refreshToken")
        .and_then(|t| t.as_str())
        .map(str::to_string)
}

fn assert_no_access_token(path: &Path) {
    let raw = std::fs::read_to_string(path).expect("session file readable");
    assert!(
        !raw.contains("accessToken"),
        "session file must not contain the access token"
    );
}

#[tokio::test]
#[ignore = "needs a live enterprise server (CCSE_E2E_SERVER / CCSE_E2E_PASSWORD)"]
async fn e2e_against_real_server() {
    let Ok(server) = std::env::var("CCSE_E2E_SERVER") else {
        eprintln!("CCSE_E2E_SERVER not set, skipping");
        return;
    };
    let Ok(password) = std::env::var("CCSE_E2E_PASSWORD") else {
        eprintln!("CCSE_E2E_PASSWORD not set, skipping");
        return;
    };
    let username = std::env::var("CCSE_E2E_USER").unwrap_or_else(|_| "admin".to_string());

    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join(SESSION_FILE_NAME);
    let session = EnterpriseSession::new(dir.path().to_path_buf());

    // (1) wrong password → Err carrying the server message, not logged in.
    let err = session
        .login(&server, &username, "definitely-not-the-password")
        .await
        .expect_err("wrong password must fail");
    eprintln!("[e2e] wrong password error: {err}");
    assert!(err.is_unauthorized(), "expected 401, got {err:?}");
    assert_ne!(
        err.to_string(),
        "Authentication failed",
        "expected the server's error.message, got the client fallback"
    );
    let state = session.state().await;
    assert!(!state.logged_in);
    assert_eq!(state.last_error.as_deref(), Some(err.to_string().as_str()));

    // (2) correct login.
    let state = session
        .login(&server, &username, &password)
        .await
        .expect("login must succeed");
    assert!(state.logged_in, "state: {state:?}");
    assert!(!state.offline);
    assert_eq!(
        state.server_url.as_deref(),
        Some(server.trim_end_matches('/'))
    );
    assert_eq!(state.user.as_ref().unwrap().username, username);
    assert!(
        state.permissions.iter().any(|p| p == "users.manage"),
        "permissions: {:?}",
        state.permissions
    );
    let config = state.config.as_ref().expect("config fetched after login");
    assert!(!config.server_time.is_empty());
    assert!(
        state.last_error.is_none(),
        "lastError: {:?}",
        state.last_error
    );
    eprintln!(
        "[e2e] logged in as {} with {:?}, serverTime {}",
        username, state.permissions, config.server_time
    );

    // (3) file has no access token; forced refresh rotates the refresh token.
    assert_no_access_token(&file);
    let rt_before = stored_refresh_token(&file).expect("refresh token stored");
    session.forget_access_token_for_test().await;
    let state = session
        .refresh_config()
        .await
        .expect("refresh_config after forced refresh");
    assert!(state.logged_in, "state: {state:?}");
    assert!(
        state.last_error.is_none(),
        "lastError: {:?}",
        state.last_error
    );
    assert_no_access_token(&file);
    let rt_after = stored_refresh_token(&file).expect("refresh token stored");
    assert_ne!(rt_before, rt_after, "refresh token must rotate");

    // (4) "app restart": a second session from the same file works without login.
    let restarted = EnterpriseSession::new(dir.path().to_path_buf());
    let state = restarted.state().await;
    assert!(state.logged_in);
    assert!(state.config.is_some(), "cached config survives restart");
    let state = restarted
        .refresh_config()
        .await
        .expect("refresh_config after restart");
    assert!(state.logged_in, "state: {state:?}");
    assert!(
        state.last_error.is_none(),
        "lastError: {:?}",
        state.last_error
    );
    let rt_restarted = stored_refresh_token(&file).expect("refresh token stored");
    assert_ne!(rt_after, rt_restarted, "restart refresh rotates too");
    drop(session); // its in-memory state is stale now (token rotated by `restarted`)

    // (5) logout clears local state, keeps serverUrl, and revokes on the server.
    let state = restarted.logout().await;
    assert!(!state.logged_in);
    assert!(state.user.is_none());
    assert!(state.config.is_none());
    assert_eq!(
        state.server_url.as_deref(),
        Some(server.trim_end_matches('/'))
    );
    assert!(stored_refresh_token(&file).is_none());

    // The server logout runs in the background. Probing is destructive (a
    // successful refresh would rotate the token and a second probe would then
    // get 401 for "reuse"), so wait first and probe exactly once.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let resp = reqwest::Client::new()
        .post(endpoint(server.trim_end_matches('/'), "/auth/refresh"))
        .json(&serde_json::json!({ "refreshToken": rt_restarted }))
        .send()
        .await
        .expect("server reachable");
    assert_eq!(
        resp.status().as_u16(),
        401,
        "refresh token must be revoked after logout"
    );
    eprintln!("[e2e] all steps passed");
}

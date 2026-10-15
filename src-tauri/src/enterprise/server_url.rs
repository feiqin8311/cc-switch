//! Enterprise server URL validation / normalization.

use url::Url;

/// Normalize and validate a user-entered enterprise server URL.
///
/// - trims whitespace and trailing `/`
/// - scheme must be `http` or `https`
/// - userinfo, query and fragment are rejected
///
/// Returns the normalized URL without a trailing slash, e.g. `https://ent.example.com`.
pub fn normalize_server_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Server URL is required".to_string());
    }

    let parsed = Url::parse(trimmed).map_err(|_| "Invalid server URL".to_string())?;

    parsed
        .host()
        .ok_or_else(|| "Server URL must include a host".to_string())?;

    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("Server URL must use http or https".to_string()),
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Server URL must not contain a username or password".to_string());
    }
    if parsed.query().is_some() {
        return Err("Server URL must not contain a query string".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("Server URL must not contain a fragment".to_string());
    }

    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::normalize_server_url;

    #[test]
    fn accepts_https_and_normalizes() {
        assert_eq!(
            normalize_server_url("  https://Ent.Example.com/  ").unwrap(),
            "https://ent.example.com"
        );
        assert_eq!(
            normalize_server_url("https://ent.example.com:8443//").unwrap(),
            "https://ent.example.com:8443"
        );
        assert_eq!(
            normalize_server_url("https://ent.example.com/cc/").unwrap(),
            "https://ent.example.com/cc"
        );
        // default port is dropped by the URL parser
        assert_eq!(
            normalize_server_url("https://ent.example.com:443").unwrap(),
            "https://ent.example.com"
        );
    }

    #[test]
    fn accepts_http() {
        assert_eq!(
            normalize_server_url("http://localhost:8787/").unwrap(),
            "http://localhost:8787"
        );
        assert_eq!(
            normalize_server_url("http://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            normalize_server_url("http://[::1]:8787").unwrap(),
            "http://[::1]:8787"
        );
        assert_eq!(
            normalize_server_url("http://ent.example.com").unwrap(),
            "http://ent.example.com"
        );
        assert_eq!(
            normalize_server_url("  http://116.205.229.31:41827/  ").unwrap(),
            "http://116.205.229.31:41827"
        );
        assert_eq!(
            normalize_server_url("http://192.168.1.10").unwrap(),
            "http://192.168.1.10"
        );
    }

    #[test]
    fn rejects_other_schemes_and_garbage() {
        assert!(normalize_server_url("").is_err());
        assert!(normalize_server_url("   ").is_err());
        assert!(normalize_server_url("ent.example.com").is_err());
        assert!(normalize_server_url("ftp://ent.example.com").is_err());
        assert!(normalize_server_url("file:///etc/passwd").is_err());
        assert!(normalize_server_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn rejects_userinfo_query_fragment() {
        assert!(normalize_server_url("https://user@ent.example.com").is_err());
        assert!(normalize_server_url("https://user:pw@ent.example.com").is_err());
        assert!(normalize_server_url("https://ent.example.com?x=1").is_err());
        assert!(normalize_server_url("https://ent.example.com/?").is_err());
        assert!(normalize_server_url("https://ent.example.com#frag").is_err());
        assert!(normalize_server_url("https://ent.example.com/#").is_err());
    }
}

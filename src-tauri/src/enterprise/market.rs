//! Enterprise marketplace (contract "Phase 4"): skills and Codex plugins
//! published by the enterprise server, installed with one click. Mandatory
//! items are installed / updated automatically in the background.
//!
//! - skills go through [`SkillService::install_from_zip`] and are enabled for
//!   Codex only;
//! - plugins live in a local Codex marketplace
//!   `<app config dir>/enterprise-marketplace/` named `ccswitch-enterprise`
//!   and are installed with the `codex plugin ...` CLI;
//! - MCP servers (a JSON definition) go through [`McpService`] under the item
//!   id and are enabled for Codex;
//! - prompts (a JSON definition) become Codex prompts `enterprise-<id>` through
//!   [`PromptService`]; a mandatory prompt is also enabled (AGENTS.md);
//! - what we installed is recorded in `<app config dir>/enterprise_market.json`
//!   (0600).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{endpoint, EnterpriseSession, EnterpriseState};
use crate::app_config::{AppType, McpApps, McpServer};
use crate::database::Database;
use crate::prompt::Prompt;
use crate::services::skill::SkillService;
use crate::services::{McpService, PromptService};

pub const MARKETPLACE_NAME: &str = "ccswitch-enterprise";
const MARKETPLACE_DISPLAY_NAME: &str = "CC Switch Enterprise";
pub const PERMISSION_INSTALL: &str = "market.install";
/// Same as the contract's `MAX_MARKET_PACKAGE_BYTES`.
pub const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 5000;
const MAX_EXTRACTED_BYTES: u64 = 100 * 1024 * 1024;
const STATE_FILE_NAME: &str = "enterprise_market.json";
const MARKETPLACE_DIR_NAME: &str = "enterprise-marketplace";
const SHA256_HEADER: &str = "x-content-sha256";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const CODEX_TIMEOUT: Duration = Duration::from_secs(90);
const CODEX_LOCATE_TIMEOUT: Duration = Duration::from_secs(20);
const AUTO_INSTALL_FIRST_DELAY: Duration = Duration::from_secs(45);
const AUTO_INSTALL_INTERVAL: Duration = Duration::from_secs(600);
const SKILL_MARKER: &str = "SKILL.md";
const PLUGIN_MARKER: &str = ".codex-plugin/plugin.json";
/// Same as the contract's `MAX_MCP_DEFINITION_BYTES`.
const MAX_MCP_DEFINITION_BYTES: u64 = 64 * 1024;
/// Same as the contract's `MAX_PROMPT_DEFINITION_BYTES`.
const MAX_PROMPT_DEFINITION_BYTES: u64 = 256 * 1024;
/// Prompt ids on the device, so they never collide with the user's own.
const PROMPT_ID_PREFIX: &str = "enterprise-";

// ---------------------------------------------------------------------------
// Wire / state types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarketItemKind {
    Skill,
    Plugin,
    Mcp,
    Prompt,
}

/// `MarketItem` of the contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketItem {
    pub id: String,
    pub kind: MarketItemKind,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub version: String,
    #[serde(default)]
    pub mandatory: bool,
    pub sha256: String,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub published_by_name: Option<String>,
}

#[derive(Deserialize)]
struct ListMarketItemsResponse {
    items: Vec<MarketItem>,
}

/// One row of `enterprise_market_list`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketListEntry {
    pub item: MarketItem,
    pub installed_version: Option<String>,
    pub update_available: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledItem {
    pub kind: MarketItemKind,
    pub version: String,
    pub sha256: String,
    pub installed_at: String,
    /// Skill directory name (skills only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_dir: Option<String>,
    /// Managed skill id, e.g. `local:<dir>` (skills only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_id: Option<String>,
}

/// Content of `enterprise_market.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MarketState {
    #[serde(default)]
    pub items: BTreeMap<String, InstalledItem>,
}

/// Where the marketplace keeps its files.
#[derive(Debug, Clone)]
pub struct MarketPaths {
    pub state_file: PathBuf,
    pub marketplace_dir: PathBuf,
}

impl MarketPaths {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            state_file: config_dir.join(STATE_FILE_NAME),
            marketplace_dir: config_dir.join(MARKETPLACE_DIR_NAME),
        }
    }

    pub fn from_app_config() -> Self {
        Self::new(&crate::config::get_app_config_dir())
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// Same rule as the contract's `ProviderIdSchema`: `^[a-z0-9][a-z0-9-]{1,31}$`.
/// The id ends up in file paths and CLI arguments, so it is always checked.
pub fn validate_item_id(id: &str) -> Result<(), String> {
    let bytes = id.as_bytes();
    let ok = (2..=32).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-');
    if ok {
        Ok(())
    } else {
        Err(format!("Invalid marketplace item id: {id:?}"))
    }
}

fn has_install_permission(state: &EnterpriseState) -> bool {
    state.logged_in && state.permissions.iter().any(|p| p == PERMISSION_INSTALL)
}

fn normalize_sha(s: &str) -> String {
    s.trim().to_ascii_lowercase()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_outdated(installed: &InstalledItem, item: &MarketItem) -> bool {
    installed.version != item.version
        || normalize_sha(&installed.sha256) != normalize_sha(&item.sha256)
        || installed.kind != item.kind
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn op_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn remove_dir_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to remove {}: {e}", path.display())),
    }
}

fn is_not_found_error(e: &anyhow::Error) -> bool {
    e.to_string().contains("Skill not found")
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

pub fn load_state(path: &Path) -> MarketState {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            log::warn!(
                "[EnterpriseMarket] ignoring unreadable {}: {e}",
                path.display()
            );
            MarketState::default()
        }),
        Err(_) => MarketState::default(),
    }
}

pub fn save_state(path: &Path, state: &MarketState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    crate::config::write_json_file_private(path, state)
        .map_err(|e| format!("Failed to save marketplace state: {e}"))
}

// ---------------------------------------------------------------------------
// Package download (size-capped, sha256-verified)
// ---------------------------------------------------------------------------

/// Accumulates a package into a temp file while counting bytes and hashing.
struct PackageSink {
    file: tempfile::NamedTempFile,
    hasher: Sha256,
    written: u64,
    limit: u64,
}

impl PackageSink {
    fn new(limit: u64) -> Result<Self, String> {
        Ok(Self {
            file: tempfile::NamedTempFile::new()
                .map_err(|e| format!("Failed to create temp file: {e}"))?,
            hasher: Sha256::new(),
            written: 0,
            limit,
        })
    }

    fn push(&mut self, chunk: &[u8]) -> Result<(), String> {
        if self.written + chunk.len() as u64 > self.limit {
            return Err(format!(
                "Package exceeds the {} MB limit",
                self.limit / (1024 * 1024)
            ));
        }
        self.hasher.update(chunk);
        self.file
            .write_all(chunk)
            .map_err(|e| format!("Failed to write package: {e}"))?;
        self.written += chunk.len() as u64;
        Ok(())
    }

    fn finish(
        mut self,
        header_sha: &str,
        listed_sha: &str,
    ) -> Result<tempfile::NamedTempFile, String> {
        self.file
            .flush()
            .map_err(|e| format!("Failed to write package: {e}"))?;
        let digest = to_hex(&self.hasher.finalize());
        verify_package_digest(&digest, header_sha, listed_sha)?;
        Ok(self.file)
    }
}

/// The computed digest must match both the `X-Content-SHA256` header and the
/// digest listed in `GET /market/items`.
fn verify_package_digest(computed: &str, header_sha: &str, listed_sha: &str) -> Result<(), String> {
    let computed = normalize_sha(computed);
    if computed != normalize_sha(header_sha) {
        return Err("Package checksum does not match the X-Content-SHA256 header".into());
    }
    if computed != normalize_sha(listed_sha) {
        return Err("Package checksum does not match the marketplace listing".into());
    }
    Ok(())
}

pub(super) async fn download_package(
    session: &EnterpriseSession,
    item: &MarketItem,
) -> Result<tempfile::NamedTempFile, String> {
    validate_item_id(&item.id)?;
    let path = format!("/market/items/{}/package", item.id);
    let (_, mut resp) = session
        .send_authenticated(|http, base, token| {
            http.get(endpoint(base, &path))
                .bearer_auth(token)
                .timeout(DOWNLOAD_TIMEOUT)
        })
        .await
        .map_err(String::from)?;

    if resp
        .content_length()
        .is_some_and(|len| len > MAX_PACKAGE_BYTES)
    {
        return Err(format!(
            "Package exceeds the {} MB limit",
            MAX_PACKAGE_BYTES / (1024 * 1024)
        ));
    }
    let header_sha = resp
        .headers()
        .get(SHA256_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| "Package response is missing the X-Content-SHA256 header".to_string())?;

    let mut sink = PackageSink::new(MAX_PACKAGE_BYTES)?;
    while let Some(chunk) = resp.chunk().await.map_err(|e| {
        log::warn!("[EnterpriseMarket] download of {} failed: {e}", item.id);
        "Network error while downloading the package".to_string()
    })? {
        sink.push(&chunk)?;
    }
    sink.finish(&header_sha, &item.sha256)
}

async fn fetch_items(session: &EnterpriseSession) -> Result<Vec<MarketItem>, String> {
    session
        .get_json::<ListMarketItemsResponse>("/market/items")
        .await
        .map(|r| r.items)
        .map_err(String::from)
}

// ---------------------------------------------------------------------------
// Safe extraction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct ExtractLimits {
    max_entries: usize,
    max_total_bytes: u64,
}

const DEFAULT_LIMITS: ExtractLimits = ExtractLimits {
    max_entries: MAX_ZIP_ENTRIES,
    max_total_bytes: MAX_EXTRACTED_BYTES,
};

/// Split a zip entry name into normal components, rejecting absolute paths,
/// `..`, and drive / stream prefixes (`C:`).
fn entry_components(name: &str) -> Result<Vec<String>, String> {
    if name.starts_with('/') || name.starts_with('\\') {
        return Err(format!("Package contains an absolute path: {name}"));
    }
    let mut out = Vec::new();
    for part in name.split(['/', '\\']) {
        match part {
            "" | "." => continue,
            ".." => return Err(format!("Package contains a path traversal entry: {name}")),
            p if p.contains(':') || p.contains('\0') => {
                return Err(format!("Package contains an invalid path: {name}"))
            }
            p => out.push(p.to_string()),
        }
    }
    Ok(out)
}

fn is_ignored_entry(components: &[String]) -> bool {
    components[0] == "__MACOSX" || components.last().is_some_and(|c| c == ".DS_Store")
}

/// How many leading components to strip: 0 when `marker` is at the zip root,
/// 1 when everything sits in a single top-level folder that contains `marker`.
fn package_prefix_len(
    entries: &[(usize, Vec<String>, bool)],
    marker: &[&str],
) -> Result<usize, String> {
    let has_marker = |strip: usize| {
        entries.iter().any(|(_, comps, is_dir)| {
            !is_dir
                && comps.len() == marker.len() + strip
                && comps[strip..]
                    .iter()
                    .map(String::as_str)
                    .eq(marker.iter().copied())
        })
    };
    if has_marker(0) {
        return Ok(0);
    }
    let tops: BTreeSet<&str> = entries.iter().map(|(_, c, _)| c[0].as_str()).collect();
    let single_folder = tops.len() == 1
        && entries
            .iter()
            .all(|(_, comps, is_dir)| comps.len() > 1 || *is_dir);
    if single_folder && has_marker(1) {
        return Ok(1);
    }
    Err(format!(
        "Invalid package layout: {} not found at the package root",
        marker.join("/")
    ))
}

/// Extract `zip_path` into `dest`. The package root is the zip root when
/// `marker` (e.g. `SKILL.md`) is there, otherwise the single top-level folder
/// that contains it. Rejects absolute paths, `..`, symlinks, too many entries
/// and too many uncompressed bytes (counted while writing, not trusted from
/// the headers).
pub(super) fn safe_extract_package(
    zip_path: &Path,
    dest: &Path,
    marker: &str,
) -> Result<(), String> {
    safe_extract_with_limits(zip_path, dest, marker, DEFAULT_LIMITS)
}

fn safe_extract_with_limits(
    zip_path: &Path,
    dest: &Path,
    marker: &str,
    limits: ExtractLimits,
) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("Failed to open package: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Package is not a valid zip: {e}"))?;
    if archive.len() > limits.max_entries {
        return Err(format!(
            "Package has too many entries ({} > {})",
            archive.len(),
            limits.max_entries
        ));
    }

    let mut entries = Vec::new();
    for i in 0..archive.len() {
        let entry = archive
            .by_index_raw(i)
            .map_err(|e| format!("Package is not a valid zip: {e}"))?;
        if entry.is_symlink() {
            return Err(format!("Package contains a symlink: {}", entry.name()));
        }
        let comps = entry_components(entry.name())?;
        if comps.is_empty() || is_ignored_entry(&comps) {
            continue;
        }
        entries.push((i, comps, entry.is_dir()));
    }

    let marker_parts: Vec<&str> = marker.split('/').collect();
    let strip = package_prefix_len(&entries, &marker_parts)?;

    fs::create_dir_all(dest).map_err(|e| format!("Failed to create {}: {e}", dest.display()))?;
    let mut total: u64 = 0;
    for (index, comps, is_dir) in entries {
        let rel = &comps[strip..];
        if rel.is_empty() {
            continue;
        }
        let out = rel.iter().fold(dest.to_path_buf(), |p, c| p.join(c));
        if is_dir {
            fs::create_dir_all(&out).map_err(|e| format!("Failed to extract package: {e}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to extract package: {e}"))?;
        }
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("Failed to read package entry: {e}"))?;
        let mode = entry.unix_mode();
        let mut writer =
            fs::File::create(&out).map_err(|e| format!("Failed to extract package: {e}"))?;
        let remaining = limits.max_total_bytes.saturating_sub(total);
        let copied = std::io::copy(&mut (&mut entry).take(remaining + 1), &mut writer)
            .map_err(|e| format!("Failed to extract package: {e}"))?;
        if copied > remaining {
            return Err(format!(
                "Package expands to more than {} MB",
                limits.max_total_bytes / (1024 * 1024)
            ));
        }
        total += copied;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let exec = mode.is_some_and(|m| m & 0o111 != 0);
            let _ = fs::set_permissions(
                &out,
                fs::Permissions::from_mode(if exec { 0o755 } else { 0o644 }),
            );
        }
        #[cfg(not(unix))]
        let _ = mode;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/// Re-pack an extracted directory as `<top>/...` so `install_from_zip` uses
/// `top` (the item id) as the skill directory name.
fn repack_dir_as_zip(src: &Path, top: &str, dest_zip: &Path) -> Result<(), String> {
    fn walk(
        zw: &mut zip::ZipWriter<fs::File>,
        dir: &Path,
        prefix: &str,
        opts: zip::write::SimpleFileOptions,
    ) -> Result<(), String> {
        let mut entries: Vec<_> = fs::read_dir(dir)
            .map_err(|e| format!("Failed to read {}: {e}", dir.display()))?
            .flatten()
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            let ft = entry
                .file_type()
                .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
            let rel = format!("{prefix}/{name}");
            if ft.is_dir() {
                zw.add_directory(rel.clone(), opts)
                    .map_err(|e| format!("Failed to repack skill: {e}"))?;
                walk(zw, &path, &rel, opts)?;
            } else if ft.is_file() {
                zw.start_file(rel, opts)
                    .map_err(|e| format!("Failed to repack skill: {e}"))?;
                let mut f = fs::File::open(&path)
                    .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
                std::io::copy(&mut f, zw).map_err(|e| format!("Failed to repack skill: {e}"))?;
            }
        }
        Ok(())
    }

    let file = fs::File::create(dest_zip).map_err(|e| format!("Failed to repack skill: {e}"))?;
    let mut zw = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();
    zw.add_directory(top, opts)
        .map_err(|e| format!("Failed to repack skill: {e}"))?;
    walk(&mut zw, src, top, opts)?;
    zw.finish()
        .map_err(|e| format!("Failed to repack skill: {e}"))?;
    Ok(())
}

fn install_skill_blocking(
    db: &Arc<Database>,
    paths: &MarketPaths,
    state: &mut MarketState,
    item: &MarketItem,
    package: &Path,
) -> Result<InstalledItem, String> {
    let work = tempfile::tempdir().map_err(|e| format!("Failed to create temp dir: {e}"))?;
    let root = work.path().join("pkg");
    safe_extract_package(package, &root, SKILL_MARKER)?;
    let repacked = work.path().join(format!("{}.zip", item.id));
    repack_dir_as_zip(&root, &item.id, &repacked)?;

    // Update: remove the previous version first (install_from_zip skips taken
    // directories). The state entry goes with it so a failed install below
    // shows up as "not installed" rather than a stale version.
    if let Some(previous) = state.items.get(&item.id).cloned() {
        remove_installed_blocking(db, paths, state, &item.id, &previous)?;
    }

    let result = SkillService::install_from_zip(db, &repacked, &AppType::Codex)
        .map_err(|e| e.to_string())?;
    if let Some(skipped) = result.skipped.first() {
        return Err(format!(
            "Skill directory '{}' is already used by installed skill '{}'; remove it first",
            skipped.directory, skipped.existing_name
        ));
    }
    let skill = result
        .installed
        .into_iter()
        .next()
        .ok_or_else(|| "No skill was installed from the package".to_string())?;
    Ok(InstalledItem {
        kind: MarketItemKind::Skill,
        version: item.version.clone(),
        sha256: normalize_sha(&item.sha256),
        installed_at: now_rfc3339(),
        skill_dir: Some(skill.directory),
        skill_id: Some(skill.id),
    })
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

/// Parse an `mcp` package (contract `McpDefinitionSchema`). The server already
/// validated it; this only checks what the MCP sync relies on.
fn parse_mcp_definition(bytes: &[u8]) -> Result<serde_json::Value, String> {
    if bytes.len() as u64 > MAX_MCP_DEFINITION_BYTES {
        return Err("MCP definition is too large".into());
    }
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| "MCP definition is not valid JSON".to_string())?;
    let obj = value
        .as_object()
        .ok_or_else(|| "MCP definition must be a JSON object".to_string())?;
    let non_empty = |key: &str| {
        obj.get(key)
            .and_then(|v| v.as_str())
            .is_some_and(|v| !v.trim().is_empty())
    };
    match obj.get("type").and_then(|v| v.as_str()) {
        Some("stdio") if non_empty("command") => Ok(value),
        Some("stdio") => Err("stdio MCP definition needs a command".into()),
        Some("http" | "sse")
            if obj
                .get("url")
                .and_then(|v| v.as_str())
                .is_some_and(|u| u.starts_with("https://") || u.starts_with("http://")) =>
        {
            Ok(value)
        }
        Some("http" | "sse") => Err("http/sse MCP definition needs an http(s) url".into()),
        _ => Err("MCP definition type must be stdio, http or sse".into()),
    }
}

fn mcp_server_exists(db: &Database, id: &str) -> Result<bool, String> {
    db.get_all_mcp_servers()
        .map(|servers| servers.contains_key(id))
        .map_err(|e| e.to_string())
}

fn install_mcp_blocking(
    db: &Arc<Database>,
    state: &MarketState,
    item: &MarketItem,
    package: &Path,
) -> Result<InstalledItem, String> {
    let bytes = fs::read(package).map_err(|e| format!("Failed to read the package: {e}"))?;
    let definition = parse_mcp_definition(&bytes)?;

    let ours = state
        .items
        .get(&item.id)
        .is_some_and(|inst| inst.kind == MarketItemKind::Mcp);
    let existing = db
        .get_all_mcp_servers()
        .map_err(|e| e.to_string())?
        .shift_remove(&item.id);
    if existing.is_some() && !ours {
        return Err(format!(
            "An MCP server named '{}' already exists on this computer; remove or rename it first",
            item.id
        ));
    }
    // Updates keep the apps the user turned on; Codex is always on.
    let mut apps = existing.map(|s| s.apps).unwrap_or_else(McpApps::default);
    apps.codex = true;
    let description = item.description.trim();
    McpService::upsert_server_in(
        db,
        McpServer {
            id: item.id.clone(),
            name: item.name.clone(),
            server: definition,
            apps,
            description: (!description.is_empty()).then(|| description.to_string()),
            homepage: None,
            docs: None,
            tags: Vec::new(),
        },
    )
    .map_err(|e| e.to_string())?;

    Ok(InstalledItem {
        kind: MarketItemKind::Mcp,
        version: item.version.clone(),
        sha256: normalize_sha(&item.sha256),
        installed_at: now_rfc3339(),
        skill_dir: None,
        skill_id: None,
    })
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

fn prompt_id(item_id: &str) -> String {
    format!("{PROMPT_ID_PREFIX}{item_id}")
}

/// Parse a `prompt` package (contract `PromptDefinitionSchema`): its content.
fn parse_prompt_definition(bytes: &[u8]) -> Result<String, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct PromptDefinition {
        content: String,
    }
    if bytes.len() as u64 > MAX_PROMPT_DEFINITION_BYTES {
        return Err("Prompt definition is too large".into());
    }
    let def: PromptDefinition = serde_json::from_slice(bytes)
        .map_err(|_| "Prompt definition is not valid JSON with a content string".to_string())?;
    if def.content.trim().is_empty() {
        return Err("Prompt content is empty".into());
    }
    Ok(def.content)
}

fn codex_prompts(db: &Database) -> Result<indexmap::IndexMap<String, Prompt>, String> {
    db.get_prompts(AppType::Codex.as_str())
        .map_err(|e| e.to_string())
}

fn install_prompt_blocking(
    db: &Arc<Database>,
    item: &MarketItem,
    package: &Path,
) -> Result<InstalledItem, String> {
    let bytes = fs::read(package).map_err(|e| format!("Failed to read the package: {e}"))?;
    let content = parse_prompt_definition(&bytes)?;
    let id = prompt_id(&item.id);
    let existing = codex_prompts(db)?.shift_remove(&id);
    // An update keeps whether the user enabled it.
    let enabled = existing.as_ref().is_some_and(|p| p.enabled);
    let now = chrono::Utc::now().timestamp();
    let description = item.description.trim();
    PromptService::upsert_prompt_in(
        db,
        AppType::Codex,
        &id,
        Prompt {
            id: id.clone(),
            name: item.name.clone(),
            content,
            description: (!description.is_empty()).then(|| description.to_string()),
            enabled,
            created_at: Some(existing.and_then(|p| p.created_at).unwrap_or(now)),
            updated_at: Some(now),
        },
    )
    .map_err(|e| e.to_string())?;
    // Mandatory: enable it. Enabling backs up the user's current AGENTS.md as a prompt.
    if item.mandatory && !enabled {
        PromptService::enable_prompt_in(db, AppType::Codex, &id).map_err(|e| e.to_string())?;
    }

    Ok(InstalledItem {
        kind: MarketItemKind::Prompt,
        version: item.version.clone(),
        sha256: normalize_sha(&item.sha256),
        installed_at: now_rfc3339(),
        skill_dir: None,
        skill_id: None,
    })
}

/// Remove the prompt; when it is the enabled one, AGENTS.md is cleared first.
fn remove_prompt_blocking(db: &Arc<Database>, item_id: &str) -> Result<(), String> {
    let id = prompt_id(item_id);
    let Some(mut prompt) = codex_prompts(db)?.shift_remove(&id) else {
        return Ok(());
    };
    if prompt.enabled {
        prompt.enabled = false;
        PromptService::upsert_prompt_in(db, AppType::Codex, &id, prompt)
            .map_err(|e| e.to_string())?;
    }
    db.delete_prompt(AppType::Codex.as_str(), &id)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Codex plugins
// ---------------------------------------------------------------------------

/// `.agents/plugins/marketplace.json` listing `plugin_ids`.
fn marketplace_manifest(plugin_ids: &BTreeSet<String>) -> serde_json::Value {
    let plugins: Vec<serde_json::Value> = plugin_ids
        .iter()
        .map(|id| {
            serde_json::json!({
                "name": id,
                "source": { "source": "local", "path": format!("./plugins/{id}") },
                "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
                "category": "Enterprise",
            })
        })
        .collect();
    serde_json::json!({
        "name": MARKETPLACE_NAME,
        "interface": { "displayName": MARKETPLACE_DISPLAY_NAME },
        "plugins": plugins,
    })
}

fn manifest_path(marketplace_dir: &Path) -> PathBuf {
    marketplace_dir
        .join(".agents")
        .join("plugins")
        .join("marketplace.json")
}

fn write_marketplace_manifest(
    marketplace_dir: &Path,
    plugin_ids: &BTreeSet<String>,
) -> Result<(), String> {
    let path = manifest_path(marketplace_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let bytes = serde_json::to_vec_pretty(&marketplace_manifest(plugin_ids))
        .map_err(|e| format!("Failed to serialize marketplace.json: {e}"))?;
    crate::config::atomic_write(&path, &bytes)
        .map_err(|e| format!("Failed to write marketplace.json: {e}"))
}

/// Plugins recorded in `state` whose folder exists.
fn installed_plugin_ids(paths: &MarketPaths, state: &MarketState) -> BTreeSet<String> {
    state
        .items
        .iter()
        .filter(|(id, inst)| {
            inst.kind == MarketItemKind::Plugin
                && paths.marketplace_dir.join("plugins").join(id).is_dir()
        })
        .map(|(id, _)| id.clone())
        .collect()
}

/// `.codex-plugin/plugin.json` must be valid JSON whose `name` is the item id.
pub(super) fn validate_plugin_dir(dir: &Path, id: &str) -> Result<(), String> {
    let path = dir.join(".codex-plugin").join("plugin.json");
    let text = fs::read_to_string(&path).map_err(|e| format!("Failed to read plugin.json: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("plugin.json is not valid JSON: {e}"))?;
    match value.get("name").and_then(|v| v.as_str()) {
        Some(name) if name == id => Ok(()),
        Some(name) => Err(format!(
            "plugin.json name '{name}' does not match the marketplace item id '{id}'"
        )),
        None => Err("plugin.json has no name".into()),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Registration {
    Missing,
    Registered,
    /// Registered under our name but from another source.
    Different,
}

fn same_path(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Is `[marketplaces.ccswitch-enterprise]` in Codex's config.toml pointing at `dir`?
fn marketplace_registration(config_toml: &str, dir: &Path) -> Registration {
    let Ok(doc) = config_toml.parse::<toml::Table>() else {
        return Registration::Missing;
    };
    let Some(entry) = doc
        .get("marketplaces")
        .and_then(|m| m.get(MARKETPLACE_NAME))
    else {
        return Registration::Missing;
    };
    match entry.get("source").and_then(|s| s.as_str()) {
        Some(source) if same_path(Path::new(source), dir) => Registration::Registered,
        _ => Registration::Different,
    }
}

/// The Codex CLI, located the same way as the CLI lifecycle commands so it is
/// found when the app is launched from Finder with a minimal PATH.
struct CodexCli {
    program: PathBuf,
    path_env: OsString,
    codex_home: Option<PathBuf>,
    cwd: PathBuf,
}

impl CodexCli {
    fn locate(cwd: &Path) -> Result<Self, String> {
        let program = crate::commands::locate_tool_executable("codex", Some(CODEX_LOCATE_TIMEOUT))
            .map_err(|e| {
                format!("Codex CLI not found ({e}); install Codex CLI to use enterprise plugins")
            })?;
        let mut dirs: Vec<PathBuf> = program
            .parent()
            .map(Path::to_path_buf)
            .into_iter()
            .collect();
        if let Some(current) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&current));
        }
        let path_env = std::env::join_paths(dirs)
            .unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default());
        Ok(Self {
            program,
            path_env,
            codex_home: crate::settings::get_codex_override_dir(),
            cwd: cwd.to_path_buf(),
        })
    }

    /// Run `codex <args>`; non-zero exit → error carrying stderr.
    fn run(&self, args: &[&str]) -> Result<String, String> {
        let mut cmd = Command::new(&self.program);
        cmd.args(args)
            .env("PATH", &self.path_env)
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(home) = &self.codex_home {
            cmd.env("CODEX_HOME", home);
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let label = format!("codex {}", args.join(" "));
        let output = run_with_timeout(cmd, CODEX_TIMEOUT).map_err(|e| format!("`{label}`: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() {
            return Ok(stdout);
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        let detail: String = detail.chars().take(2000).collect();
        Err(format!("`{label}` failed ({}): {detail}", output.status))
    }
}

fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<Output, String> {
    let mut child = cmd.spawn().map_err(|e| format!("failed to start: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let read_all = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    };
    let out_handle = read_all(stdout.map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err_handle = read_all(stderr.map(|p| Box::new(p) as Box<dyn Read + Send>));

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("timed out after {} s", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => {
                let _ = child.kill();
                return Err(format!("failed to wait: {e}"));
            }
        }
    };
    Ok(Output {
        status,
        stdout: out_handle.join().unwrap_or_default(),
        stderr: err_handle.join().unwrap_or_default(),
    })
}

fn ensure_marketplace_registered(cli: &CodexCli, dir: &Path) -> Result<(), String> {
    let config =
        fs::read_to_string(crate::codex_config::get_codex_config_path()).unwrap_or_default();
    let source = dir
        .to_str()
        .ok_or_else(|| format!("Marketplace path is not valid UTF-8: {}", dir.display()))?;
    match marketplace_registration(&config, dir) {
        Registration::Registered => Ok(()),
        Registration::Different => {
            cli.run(&["plugin", "marketplace", "remove", MARKETPLACE_NAME])?;
            cli.run(&["plugin", "marketplace", "add", source])
                .map(|_| ())
        }
        Registration::Missing => match cli.run(&["plugin", "marketplace", "add", source]) {
            Ok(_) => Ok(()),
            // config.toml unreadable but codex knows the name from another source.
            Err(e) if e.contains("different source") => {
                cli.run(&["plugin", "marketplace", "remove", MARKETPLACE_NAME])?;
                cli.run(&["plugin", "marketplace", "add", source])
                    .map(|_| ())
            }
            Err(e) => Err(e),
        },
    }
}

fn plugin_selector(id: &str) -> String {
    format!("{id}@{MARKETPLACE_NAME}")
}

fn install_plugin_blocking(
    paths: &MarketPaths,
    state: &MarketState,
    item: &MarketItem,
    package: &Path,
) -> Result<InstalledItem, String> {
    let plugins_dir = paths.marketplace_dir.join("plugins");
    fs::create_dir_all(&plugins_dir)
        .map_err(|e| format!("Failed to create {}: {e}", plugins_dir.display()))?;
    let staging = plugins_dir.join(format!(".{}.staging", item.id));
    remove_dir_if_exists(&staging)?;
    let staged = safe_extract_package(package, &staging, PLUGIN_MARKER)
        .and_then(|_| validate_plugin_dir(&staging, &item.id));
    if let Err(e) = staged {
        let _ = remove_dir_if_exists(&staging);
        return Err(e);
    }
    // Locate codex before touching the live folder.
    let cli = match CodexCli::locate(&paths.marketplace_dir) {
        Ok(cli) => cli,
        Err(e) => {
            let _ = remove_dir_if_exists(&staging);
            return Err(e);
        }
    };

    let dest = plugins_dir.join(&item.id);
    remove_dir_if_exists(&dest)?;
    fs::rename(&staging, &dest).map_err(|e| format!("Failed to install plugin files: {e}"))?;
    let was_recorded = state.items.contains_key(&item.id);
    let mut ids = installed_plugin_ids(paths, state);
    ids.insert(item.id.clone());
    write_marketplace_manifest(&paths.marketplace_dir, &ids)?;

    let selector = plugin_selector(&item.id);
    let activated = ensure_marketplace_registered(&cli, &paths.marketplace_dir).and_then(|_| {
        // Codex caches installed plugins per version; remove first so an
        // update with an unchanged plugin.json version is still refreshed.
        if let Err(e) = cli.run(&["plugin", "remove", &selector]) {
            log::debug!("[EnterpriseMarket] pre-install remove of {selector}: {e}");
        }
        cli.run(&["plugin", "add", &selector])
    });
    if let Err(e) = activated {
        if !was_recorded {
            let _ = remove_dir_if_exists(&dest);
            ids.remove(&item.id);
            let _ = write_marketplace_manifest(&paths.marketplace_dir, &ids);
        }
        return Err(e);
    }
    Ok(InstalledItem {
        kind: MarketItemKind::Plugin,
        version: item.version.clone(),
        sha256: normalize_sha(&item.sha256),
        installed_at: now_rfc3339(),
        skill_dir: None,
        skill_id: None,
    })
}

// ---------------------------------------------------------------------------
// Install / uninstall orchestration
// ---------------------------------------------------------------------------

/// Remove an installed item (skill or plugin) and drop it from `state` (saved).
fn remove_installed_blocking(
    db: &Arc<Database>,
    paths: &MarketPaths,
    state: &mut MarketState,
    id: &str,
    installed: &InstalledItem,
) -> Result<(), String> {
    match installed.kind {
        MarketItemKind::Skill => {
            if let Some(skill_id) = installed.skill_id.as_deref() {
                match SkillService::uninstall(db, skill_id) {
                    Ok(_) => {}
                    Err(e) if is_not_found_error(&e) => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
        }
        MarketItemKind::Plugin => {
            match CodexCli::locate(&paths.marketplace_dir) {
                Ok(cli) => {
                    cli.run(&["plugin", "remove", &plugin_selector(id)])?;
                }
                Err(e) => log::warn!("[EnterpriseMarket] {e}; removing plugin files only"),
            }
            remove_dir_if_exists(&paths.marketplace_dir.join("plugins").join(id))?;
            let mut remaining = state.clone();
            remaining.items.remove(id);
            write_marketplace_manifest(
                &paths.marketplace_dir,
                &installed_plugin_ids(paths, &remaining),
            )?;
        }
        MarketItemKind::Mcp => {
            McpService::delete_server_in(db, id).map_err(|e| e.to_string())?;
        }
        MarketItemKind::Prompt => remove_prompt_blocking(db, id)?,
    }
    state.items.remove(id);
    save_state(&paths.state_file, state)
}

fn install_package_blocking(
    db: &Arc<Database>,
    paths: &MarketPaths,
    item: &MarketItem,
    package: &Path,
) -> Result<(), String> {
    let mut state = load_state(&paths.state_file);
    // Kind changed on the server: remove the old one first.
    if let Some(previous) = state.items.get(&item.id).cloned() {
        if previous.kind != item.kind {
            remove_installed_blocking(db, paths, &mut state, &item.id, &previous)?;
        }
    }
    let installed = match item.kind {
        MarketItemKind::Skill => install_skill_blocking(db, paths, &mut state, item, package)?,
        MarketItemKind::Plugin => install_plugin_blocking(paths, &state, item, package)?,
        MarketItemKind::Mcp => install_mcp_blocking(db, &state, item, package)?,
        MarketItemKind::Prompt => install_prompt_blocking(db, item, package)?,
    };
    state.items.insert(item.id.clone(), installed);
    save_state(&paths.state_file, &state)
}

async fn install_item(
    session: &EnterpriseSession,
    db: &Arc<Database>,
    paths: &MarketPaths,
    item: &MarketItem,
) -> Result<(), String> {
    validate_item_id(&item.id)?;
    let _guard = op_lock().lock().await;
    let package = download_package(session, item).await?;
    let (db, paths, item) = (db.clone(), paths.clone(), item.clone());
    tauri::async_runtime::spawn_blocking(move || {
        install_package_blocking(&db, &paths, &item, package.path())
    })
    .await
    .map_err(|e| format!("Install task failed: {e}"))?
}

/// Is the recorded install still there (user may have removed it elsewhere)?
fn is_present(
    db: &Arc<Database>,
    paths: &MarketPaths,
    id: &str,
    installed: &InstalledItem,
) -> bool {
    match installed.kind {
        MarketItemKind::Skill => installed
            .skill_id
            .as_deref()
            .is_some_and(|sid| matches!(db.get_installed_skill(sid), Ok(Some(_)))),
        MarketItemKind::Plugin => paths.marketplace_dir.join("plugins").join(id).is_dir(),
        MarketItemKind::Mcp => mcp_server_exists(db, id).unwrap_or(false),
        MarketItemKind::Prompt => codex_prompts(db).is_ok_and(|p| p.contains_key(&prompt_id(id))),
    }
}

fn list_entry(item: MarketItem, installed: Option<&InstalledItem>) -> MarketListEntry {
    MarketListEntry {
        installed_version: installed.map(|i| i.version.clone()),
        update_available: installed.is_some_and(|i| is_outdated(i, &item)),
        item,
    }
}

fn build_list(
    items: Vec<MarketItem>,
    state: &MarketState,
    present: impl Fn(&str, &InstalledItem) -> bool,
) -> Vec<MarketListEntry> {
    items
        .into_iter()
        .map(|item| {
            let installed = state
                .items
                .get(&item.id)
                .filter(|inst| present(&item.id, inst));
            list_entry(item, installed)
        })
        .collect()
}

/// Items with install state. Empty (no error) when not signed in or without
/// `market.install`.
pub async fn list(
    session: &EnterpriseSession,
    db: &Arc<Database>,
    paths: &MarketPaths,
) -> Result<Vec<MarketListEntry>, String> {
    if !has_install_permission(&session.state().await) {
        return Ok(Vec::new());
    }
    let items = fetch_items(session).await?;
    let state = load_state(&paths.state_file);
    Ok(build_list(items, &state, |id, inst| {
        is_present(db, paths, id, inst)
    }))
}

async fn require_permission(session: &EnterpriseSession) -> Result<(), String> {
    let state = session.state().await;
    if !state.logged_in {
        return Err("Not signed in to the enterprise server".into());
    }
    if !has_install_permission(&state) {
        return Err("Missing permission: market.install".into());
    }
    Ok(())
}

/// Install or update item `id`.
pub async fn install(
    session: &EnterpriseSession,
    db: &Arc<Database>,
    paths: &MarketPaths,
    id: &str,
) -> Result<MarketListEntry, String> {
    validate_item_id(id)?;
    require_permission(session).await?;
    let item = fetch_items(session)
        .await?
        .into_iter()
        .find(|i| i.id == id)
        .ok_or_else(|| format!("Marketplace item '{id}' not found"))?;
    install_item(session, db, paths, &item).await?;
    let state = load_state(&paths.state_file);
    Ok(list_entry(item.clone(), state.items.get(&item.id)))
}

/// Uninstall item `id`. Mandatory items cannot be uninstalled.
pub async fn uninstall(
    session: &EnterpriseSession,
    db: &Arc<Database>,
    paths: &MarketPaths,
    id: &str,
) -> Result<(), String> {
    validate_item_id(id)?;
    if has_install_permission(&session.state().await) {
        let items = fetch_items(session).await?;
        if items.iter().any(|i| i.id == id && i.mandatory) {
            return Err("Mandatory items cannot be uninstalled".into());
        }
    }
    let _guard = op_lock().lock().await;
    let (db, paths, id) = (db.clone(), paths.clone(), id.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = load_state(&paths.state_file);
        let installed = state
            .items
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("Marketplace item '{id}' is not installed"))?;
        remove_installed_blocking(&db, &paths, &mut state, &id, &installed)
    })
    .await
    .map_err(|e| format!("Uninstall task failed: {e}"))?
}

/// Map a local skill directory onto a marketplace id (`^[a-z0-9][a-z0-9-]{1,31}$`).
pub fn market_skill_id(directory: &str) -> Result<String, String> {
    let mut out = String::new();
    for c in directory.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    let mut id = if trimmed.len() > 32 {
        let mut cut = trimmed[..32].to_string();
        while cut.ends_with('-') {
            cut.pop();
        }
        cut
    } else {
        trimmed
    };
    if id.len() == 1 {
        id.push('0');
    }
    validate_item_id(&id).map_err(|_| {
        format!("Skill directory {directory:?} cannot be used as a marketplace id")
    })?;
    Ok(id)
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

fn skill_md_version(path: &Path) -> String {
    let Ok(text) = fs::read_to_string(path) else {
        return "1.0.0".into();
    };
    let mut in_front = false;
    for line in text.lines() {
        let t = line.trim();
        if t == "---" {
            if in_front {
                break;
            }
            in_front = true;
            continue;
        }
        if !in_front {
            continue;
        }
        let Some(rest) = t.strip_prefix("version:") else {
            continue;
        };
        let v = rest
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .trim();
        if !v.is_empty() && v.len() <= 50 {
            return v.to_string();
        }
    }
    "1.0.0".into()
}

fn pack_installed_skill(
    db: &Database,
    skill_id: &str,
) -> Result<(Vec<u8>, String, String, String, String), String> {
    let skill = db
        .get_installed_skill(skill_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Skill '{skill_id}' is not installed"))?;
    let src = SkillService::get_ssot_dir()
        .map_err(|e| e.to_string())?
        .join(&skill.directory);
    if !src.join(SKILL_MARKER).is_file() {
        return Err(format!(
            "Skill '{}' has no SKILL.md and cannot be published",
            skill.name
        ));
    }
    let id = market_skill_id(&skill.directory)?;
    let tmp = tempfile::NamedTempFile::new()
        .map_err(|e| format!("Failed to create temp zip: {e}"))?;
    repack_dir_as_zip(&src, &id, tmp.path())?;
    let bytes =
        fs::read(tmp.path()).map_err(|e| format!("Failed to read packaged skill: {e}"))?;
    if bytes.len() as u64 > MAX_PACKAGE_BYTES {
        return Err(format!(
            "Package exceeds the {} MB limit",
            MAX_PACKAGE_BYTES / (1024 * 1024)
        ));
    }
    let name = clip(skill.name.trim(), 100);
    let name = if name.is_empty() {
        skill.directory.clone()
    } else {
        name
    };
    let description = clip(skill.description.as_deref().unwrap_or(""), 1000);
    let version = skill_md_version(&src.join(SKILL_MARKER));
    Ok((bytes, id, name, description, version))
}

/// Zip a locally installed skill and PUT it to `/market/items/:id`.
pub async fn publish_skill(
    session: &EnterpriseSession,
    db: &Arc<Database>,
    skill_id: &str,
) -> Result<MarketItem, String> {
    require_permission(session).await?;
    let skill_id = skill_id.to_string();
    let db = db.clone();
    let (bytes, id, name, description, version) =
        tauri::async_runtime::spawn_blocking(move || pack_installed_skill(&db, &skill_id))
            .await
            .map_err(|e| format!("Pack task failed: {e}"))??;

    let path = format!("/market/items/{id}");
    let (_, resp) = session
        .send_authenticated(|http, base, token| {
            http.put(endpoint(base, &path))
                .query(&[
                    ("kind", "skill"),
                    ("name", name.as_str()),
                    ("description", description.as_str()),
                    ("version", version.as_str()),
                ])
                .header(reqwest::header::CONTENT_TYPE, "application/zip")
                .bearer_auth(token)
                .timeout(DOWNLOAD_TIMEOUT)
                .body(bytes.clone())
        })
        .await
        .map_err(String::from)?;
    super::client::decode_json(resp)
        .await
        .map_err(String::from)
}

// ---------------------------------------------------------------------------
// Mandatory auto-install
// ---------------------------------------------------------------------------

/// Log a failure only when it differs from the last one for `key`.
fn note_failure(last_errors: &mut HashMap<String, String>, key: &str, err: String) {
    if last_errors.get(key) != Some(&err) {
        log::warn!("[EnterpriseMarket] auto-install {key}: {err}");
        last_errors.insert(key.to_string(), err);
    }
}

async fn auto_install_once(
    session: &EnterpriseSession,
    db: &Arc<Database>,
    paths: &MarketPaths,
    last_errors: &mut HashMap<String, String>,
) {
    if !has_install_permission(&session.state().await) {
        return;
    }
    let items = match fetch_items(session).await {
        Ok(items) => {
            last_errors.remove("<list>");
            items
        }
        Err(e) => return note_failure(last_errors, "<list>", e),
    };
    for item in items.iter().filter(|i| i.mandatory) {
        let state = load_state(&paths.state_file);
        let needed = match state.items.get(&item.id) {
            None => true,
            Some(inst) => is_outdated(inst, item) || !is_present(db, paths, &item.id, inst),
        };
        if !needed {
            last_errors.remove(&item.id);
            continue;
        }
        match install_item(session, db, paths, item).await {
            Ok(()) => {
                log::info!(
                    "[EnterpriseMarket] installed mandatory {} {}",
                    item.id,
                    item.version
                );
                last_errors.remove(&item.id);
            }
            Err(e) => note_failure(last_errors, &item.id, e),
        }
    }
}

/// Background loop: first run ~45 s after start, then every 10 minutes.
pub fn spawn_mandatory_auto_install(session: Arc<EnterpriseSession>, db: Arc<Database>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(AUTO_INSTALL_FIRST_DELAY).await;
        let mut last_errors = HashMap::new();
        loop {
            let paths = MarketPaths::from_app_config();
            auto_install_once(&session, &db, &paths, &mut last_errors).await;
            tokio::time::sleep(AUTO_INSTALL_INTERVAL).await;
        }
    });
}

// ---------------------------------------------------------------------------
// Tests (hermetic: temp dirs only, never the real codex CLI)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    fn write_zip(path: &Path, files: &[(&str, &[u8])]) {
        let mut zw = zip::ZipWriter::new(fs::File::create(path).unwrap());
        let opts = SimpleFileOptions::default();
        for (name, data) in files {
            if name.ends_with('/') {
                zw.add_directory(*name, opts).unwrap();
            } else {
                zw.start_file(*name, opts).unwrap();
                zw.write_all(data).unwrap();
            }
        }
        zw.finish().unwrap();
    }

    #[test]
    fn market_skill_id_slugs_and_truncates() {
        assert_eq!(market_skill_id("alpha-skill").unwrap(), "alpha-skill");
        assert_eq!(
            market_skill_id("Amazon New Product Keyword Builder").unwrap(),
            "amazon-new-product-keyword-build"
        );
        assert_eq!(market_skill_id("A").unwrap(), "a0");
        assert!(market_skill_id("你好").is_err());
    }

    fn item(id: &str, kind: MarketItemKind, version: &str, sha: &str) -> MarketItem {
        MarketItem {
            id: id.into(),
            kind,
            name: id.into(),
            description: String::new(),
            version: version.into(),
            mandatory: false,
            sha256: sha.into(),
            size_bytes: 1,
            updated_at: String::new(),
            published_by_name: None,
        }
    }

    #[test]
    fn extract_keeps_root_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("p.zip");
        write_zip(&zip, &[("SKILL.md", b"# hi"), ("scripts/run.sh", b"echo")]);
        let dest = tmp.path().join("out");
        safe_extract_package(&zip, &dest, SKILL_MARKER).unwrap();
        assert_eq!(fs::read(dest.join("SKILL.md")).unwrap(), b"# hi");
        assert!(dest.join("scripts/run.sh").is_file());
    }

    #[test]
    fn extract_strips_single_top_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("p.zip");
        write_zip(
            &zip,
            &[
                ("demo/", b""),
                ("demo/.codex-plugin/plugin.json", b"{\"name\":\"demo\"}"),
                ("demo/skills/a/SKILL.md", b"x"),
                ("__MACOSX/demo/._x", b"junk"),
            ],
        );
        let dest = tmp.path().join("out");
        safe_extract_package(&zip, &dest, PLUGIN_MARKER).unwrap();
        assert!(dest.join(".codex-plugin/plugin.json").is_file());
        assert!(dest.join("skills/a/SKILL.md").is_file());
        assert!(!dest.join("demo").exists());
        assert!(!dest.join("__MACOSX").exists());
        validate_plugin_dir(&dest, "demo").unwrap();
        assert!(validate_plugin_dir(&dest, "other").is_err());
    }

    #[test]
    fn extract_does_not_strip_marker_parent_folder() {
        // `.codex-plugin` is the only top folder but the marker is at the root.
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("p.zip");
        write_zip(
            &zip,
            &[(".codex-plugin/plugin.json", b"{\"name\":\"demo\"}")],
        );
        let dest = tmp.path().join("out");
        safe_extract_package(&zip, &dest, PLUGIN_MARKER).unwrap();
        assert!(dest.join(".codex-plugin/plugin.json").is_file());
    }

    #[test]
    fn extract_rejects_missing_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("p.zip");
        write_zip(&zip, &[("a/README.md", b"x"), ("b/SKILL.md", b"x")]);
        let err = safe_extract_package(&zip, &tmp.path().join("out"), SKILL_MARKER).unwrap_err();
        assert!(err.contains("Invalid package layout"), "{err}");
    }

    #[test]
    fn extract_rejects_traversal_and_absolute_paths() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in [
            "../evil.txt",
            "skill/../../evil.txt",
            "/etc/evil",
            "C:/evil",
            "a\\..\\..\\evil",
        ] {
            let zip = tmp.path().join("p.zip");
            write_zip(&zip, &[("SKILL.md", b"x"), (bad, b"pwned")]);
            let dest = tmp.path().join("out");
            let err = safe_extract_package(&zip, &dest, SKILL_MARKER).unwrap_err();
            assert!(
                err.contains("traversal") || err.contains("absolute") || err.contains("invalid"),
                "{bad}: {err}"
            );
            assert!(!tmp.path().join("evil.txt").exists());
        }
    }

    #[test]
    fn extract_rejects_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("p.zip");
        {
            let mut zw = zip::ZipWriter::new(fs::File::create(&zip).unwrap());
            let opts = SimpleFileOptions::default();
            zw.start_file("SKILL.md", opts).unwrap();
            zw.write_all(b"x").unwrap();
            zw.add_symlink("link", "/etc/passwd", opts).unwrap();
            zw.finish().unwrap();
        }
        let err = safe_extract_package(&zip, &tmp.path().join("out"), SKILL_MARKER).unwrap_err();
        assert!(err.contains("symlink"), "{err}");
    }

    #[test]
    fn extract_enforces_entry_and_size_limits() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("p.zip");
        let big = vec![b'a'; 4096];
        write_zip(&zip, &[("SKILL.md", b"x"), ("a", &big), ("b", &big)]);
        let limits = ExtractLimits {
            max_entries: 2,
            max_total_bytes: 1 << 20,
        };
        let err = safe_extract_with_limits(&zip, &tmp.path().join("o1"), SKILL_MARKER, limits)
            .unwrap_err();
        assert!(err.contains("too many entries"), "{err}");
        let limits = ExtractLimits {
            max_entries: 10,
            max_total_bytes: 5000,
        };
        let err = safe_extract_with_limits(&zip, &tmp.path().join("o2"), SKILL_MARKER, limits)
            .unwrap_err();
        assert!(err.contains("expands"), "{err}");
    }

    #[test]
    fn repack_puts_files_under_item_id() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("SKILL.md"), "x").unwrap();
        fs::write(src.join("sub/a.txt"), "y").unwrap();
        let zip = tmp.path().join("r.zip");
        repack_dir_as_zip(&src, "my-skill", &zip).unwrap();
        let out = tmp.path().join("out");
        safe_extract_package(&zip, &out, SKILL_MARKER).unwrap();
        assert!(out.join("SKILL.md").is_file());
        assert!(out.join("sub/a.txt").is_file());
    }

    #[test]
    fn marketplace_manifest_lists_plugins() {
        let ids: BTreeSet<String> = ["beta".to_string(), "alpha".to_string()].into();
        let v = marketplace_manifest(&ids);
        assert_eq!(v["name"], MARKETPLACE_NAME);
        assert_eq!(v["interface"]["displayName"], MARKETPLACE_DISPLAY_NAME);
        let plugins = v["plugins"].as_array().unwrap();
        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0]["name"], "alpha");
        assert_eq!(plugins[0]["source"]["source"], "local");
        assert_eq!(plugins[0]["source"]["path"], "./plugins/alpha");
        assert_eq!(plugins[0]["policy"]["installation"], "AVAILABLE");

        let tmp = tempfile::tempdir().unwrap();
        write_marketplace_manifest(tmp.path(), &BTreeSet::new()).unwrap();
        let written: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(manifest_path(tmp.path())).unwrap()).unwrap();
        assert_eq!(written["plugins"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn installed_plugin_ids_requires_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = MarketPaths::new(tmp.path());
        let mut state = MarketState::default();
        let inst = |kind| InstalledItem {
            kind,
            version: "1".into(),
            sha256: "a".into(),
            installed_at: String::new(),
            skill_dir: None,
            skill_id: None,
        };
        state
            .items
            .insert("p1".into(), inst(MarketItemKind::Plugin));
        state
            .items
            .insert("p2".into(), inst(MarketItemKind::Plugin));
        state.items.insert("s1".into(), inst(MarketItemKind::Skill));
        fs::create_dir_all(paths.marketplace_dir.join("plugins/p1")).unwrap();
        fs::create_dir_all(paths.marketplace_dir.join("plugins/s1")).unwrap();
        let ids = installed_plugin_ids(&paths, &state);
        assert_eq!(ids.into_iter().collect::<Vec<_>>(), vec!["p1".to_string()]);
    }

    #[test]
    fn state_roundtrip_is_private() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = MarketPaths::new(tmp.path());
        assert_eq!(load_state(&paths.state_file), MarketState::default());
        let mut state = MarketState::default();
        state.items.insert(
            "my-skill".into(),
            InstalledItem {
                kind: MarketItemKind::Skill,
                version: "1.0.0".into(),
                sha256: "abc".into(),
                installed_at: "2026-10-13T00:00:00Z".into(),
                skill_dir: Some("my-skill".into()),
                skill_id: Some("local:my-skill".into()),
            },
        );
        save_state(&paths.state_file, &state).unwrap();
        assert_eq!(load_state(&paths.state_file), state);
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&paths.state_file).unwrap()).unwrap();
        assert_eq!(raw["items"]["my-skill"]["kind"], "skill");
        assert_eq!(raw["items"]["my-skill"]["skillDir"], "my-skill");
        assert_eq!(
            raw["items"]["my-skill"]["installedAt"],
            "2026-10-13T00:00:00Z"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&paths.state_file)
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // Corrupt file → empty state, no panic.
        fs::write(&paths.state_file, "{not json").unwrap();
        assert_eq!(load_state(&paths.state_file), MarketState::default());
    }

    #[test]
    fn package_sink_verifies_sha_and_size() {
        let data = b"package bytes";
        let good = to_hex(&Sha256::digest(data));

        let mut sink = PackageSink::new(1024).unwrap();
        sink.push(data).unwrap();
        let file = sink.finish(&good.to_uppercase(), &good).unwrap();
        assert_eq!(fs::read(file.path()).unwrap(), data);

        let bad = to_hex(&Sha256::digest(b"other"));
        let mut sink = PackageSink::new(1024).unwrap();
        sink.push(data).unwrap();
        let err = sink.finish(&bad, &good).unwrap_err();
        assert!(err.contains("X-Content-SHA256"), "{err}");

        let mut sink = PackageSink::new(1024).unwrap();
        sink.push(data).unwrap();
        let err = sink.finish(&good, &bad).unwrap_err();
        assert!(err.contains("listing"), "{err}");

        let mut sink = PackageSink::new(10).unwrap();
        sink.push(&data[..8]).unwrap();
        let err = sink.push(&data[8..]).unwrap_err();
        assert!(err.contains("limit"), "{err}");
    }

    #[test]
    fn registration_detection() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("enterprise-marketplace");
        fs::create_dir_all(&dir).unwrap();
        let ours = format!(
            "[marketplaces.{MARKETPLACE_NAME}]\nsource_type = \"local\"\nsource = {:?}\n",
            dir.to_str().unwrap()
        );
        assert_eq!(
            marketplace_registration(&ours, &dir),
            Registration::Registered
        );
        let other = format!(
            "[marketplaces.{MARKETPLACE_NAME}]\nsource_type = \"local\"\nsource = \"/elsewhere\"\n"
        );
        assert_eq!(
            marketplace_registration(&other, &dir),
            Registration::Different
        );
        assert_eq!(
            marketplace_registration("[marketplaces.foo]\nsource = \"/x\"\n", &dir),
            Registration::Missing
        );
        assert_eq!(
            marketplace_registration("not = [toml", &dir),
            Registration::Missing
        );
    }

    #[test]
    fn list_flags_updates() {
        let mut state = MarketState::default();
        let inst = |version: &str, sha: &str| InstalledItem {
            kind: MarketItemKind::Skill,
            version: version.into(),
            sha256: sha.into(),
            installed_at: String::new(),
            skill_dir: None,
            skill_id: None,
        };
        state.items.insert("same".into(), inst("1", "aa"));
        state.items.insert("newer".into(), inst("1", "aa"));
        state.items.insert("resha".into(), inst("1", "aa"));
        state.items.insert("gone".into(), inst("1", "aa"));
        let items = vec![
            item("same", MarketItemKind::Skill, "1", "AA"),
            item("newer", MarketItemKind::Skill, "2", "bb"),
            item("resha", MarketItemKind::Skill, "1", "cc"),
            item("fresh", MarketItemKind::Plugin, "1", "dd"),
            item("gone", MarketItemKind::Skill, "1", "aa"),
        ];
        let list = build_list(items, &state, |id, _| id != "gone");
        let flags: Vec<_> = list
            .iter()
            .map(|e| {
                (
                    e.item.id.as_str(),
                    e.installed_version.as_deref(),
                    e.update_available,
                )
            })
            .collect();
        assert_eq!(
            flags,
            vec![
                ("same", Some("1"), false),
                ("newer", Some("1"), true),
                ("resha", Some("1"), true),
                ("fresh", None, false),
                ("gone", None, false),
            ]
        );
    }

    #[test]
    fn mcp_definition_parsing() {
        let stdio = br#"{"type":"stdio","command":"npx","args":["-y","x"]}"#;
        assert_eq!(parse_mcp_definition(stdio).unwrap()["command"], "npx");
        let http = br#"{"type":"http","url":"https://mcp.example.com/mcp"}"#;
        assert!(parse_mcp_definition(http).is_ok());

        for bad in [
            &br#"{"type":"stdio","command":"  "}"#[..],
            br#"{"type":"sse","url":"ftp://x"}"#,
            br#"{"command":"npx"}"#,
            br#"["stdio"]"#,
            b"not json",
        ] {
            assert!(
                parse_mcp_definition(bad).is_err(),
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
        let huge = format!(
            r#"{{"type":"stdio","command":"{}"}}"#,
            "a".repeat(MAX_MCP_DEFINITION_BYTES as usize)
        );
        assert!(parse_mcp_definition(huge.as_bytes()).is_err());
    }

    #[test]
    fn prompt_definition_parsing() {
        assert_eq!(
            parse_prompt_definition(br##"{"content":"# Team\n- reply in Chinese"}"##).unwrap(),
            "# Team\n- reply in Chinese"
        );
        for bad in [
            &br#"{"content":"   "}"#[..],
            br#"{"content":"x","extra":1}"#,
            br#"{}"#,
            br#"{"content":1}"#,
            b"# not json",
        ] {
            assert!(
                parse_prompt_definition(bad).is_err(),
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
        let huge = format!(
            r#"{{"content":"{}"}}"#,
            "a".repeat(MAX_PROMPT_DEFINITION_BYTES as usize)
        );
        assert!(parse_prompt_definition(huge.as_bytes()).is_err());
    }

    #[test]
    fn item_id_validation() {
        for ok in ["ab", "my-skill", "0x", "a1-b2"] {
            validate_item_id(ok).unwrap();
        }
        for bad in [
            "a",
            "-ab",
            "Ab",
            "a/b",
            "../x",
            "a@b",
            "a b",
            &"a".repeat(33),
        ] {
            assert!(validate_item_id(bad).is_err(), "{bad}");
        }
    }
}

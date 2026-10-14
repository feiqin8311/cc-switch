//! Conversation retention (Phase 3): upload Codex conversations to the
//! enterprise server while the signed-in account's retention policy is enabled.
//!
//! Contract: `POST /api/v1/retention/conversations` in
//! `enterprise/contracts/src/index.ts` ("Phase 3 — conversation retention").
//!
//! Rules implemented here:
//! - Uploads happen only while signed in and the server policy is enabled.
//!   The first time that is true, this device records a cutoff for the current
//!   `(serverUrl, userId)`. There is no consent dialog.
//! - Only Codex sessions whose start time is at or after that cutoff are
//!   considered; history from before it is never sent (a resumed old session
//!   stays excluded too, because its start time is before the cutoff).
//! - The rollout files themselves are the offline buffer: a per-file cursor
//!   (`uploadedSeq` = next seq to send) only advances after a 2xx, so network
//!   errors are simply retried on the next tick.
//! - Message contents are never logged.
//!
//! ## Seq stability
//!
//! `seq` is the index of an upload item in the list derived from the parsed
//! rollout: injected messages (AGENTS.md, environment context, developer
//! prompts) are dropped, then every remaining message is split into items in
//! block order — a run of text / image / event blocks becomes one `message`,
//! each thinking block one `reasoning`, each tool call one `tool_call`, each
//! tool result one `tool_result`. Whether an item is skipped depends only on
//! data from its own rollout line, and the Codex parser emits messages in line
//! order (later lines only append, or merge into a trailing thinking-only
//! message, which this block-level split keeps stable), so re-reading a grown
//! file yields the same seq for every earlier item.
//!
//! The one unstable region is the turn that is still running at the end of the
//! file (open tool calls, the per-turn model/token metadata). Items from the
//! last user prompt onwards are therefore held back until the file has been
//! idle for [`SETTLE_AFTER`]; older turns upload right away.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use super::client::{self, EnterpriseError};
use super::session::EnterpriseSession;
use super::types::EnterpriseState;
use crate::codex_rollout_file;
use crate::session_manager::content;
use crate::session_manager::model::{ContentRef, EventKind, SessionBlock, ToolStatus};
use crate::session_manager::providers::codex;
use crate::session_manager::{SessionMessage, SessionMeta};

/// Max content per message (bytes, which is ≥ the UTF-16 length the server checks).
pub const MAX_MESSAGE_CONTENT: usize = 256 * 1024;
pub const TRUNCATION_SUFFIX: &str = "…[truncated]";
pub const MAX_ITEMS_PER_REQUEST: usize = 50;
pub const MAX_MESSAGES_PER_ITEM: usize = 2000;
/// Server limit is 16 MB; stay well below it.
pub const MAX_BODY_BYTES: usize = 12 * 1024 * 1024;
/// The running turn at the end of a rollout is uploaded once the file is idle this long.
pub const SETTLE_AFTER: Duration = Duration::from_secs(10 * 60);

const STATE_FILE: &str = "enterprise_retention.json";
const UPLOAD_PATH: &str = "/retention/conversations";
const FIRST_TICK: Duration = Duration::from_secs(30);
const TICK: Duration = Duration::from_secs(60);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);

const MAX_SESSION_ID: usize = 200;
const MAX_TITLE: usize = 500;
const MAX_PROJECT_DIR: usize = 1000;
const MAX_SHORT_FIELD: usize = 200;

// ─── Wire types ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetainedMessage {
    pub seq: u64,
    /// user | assistant | system | tool
    pub role: &'static str,
    /// message | reasoning | tool_call | tool_result
    pub kind: &'static str,
    pub content: String,
    pub tool_name: Option<String>,
    pub timestamp: Option<String>,
    pub model: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationUpload {
    pub client_session_id: String,
    pub title: Option<String>,
    pub project_dir: Option<String>,
    pub started_at: String,
    pub messages: Vec<RetainedMessage>,
}

#[derive(Serialize)]
struct UploadRequest<'a> {
    items: Vec<&'a ConversationUpload>,
}

#[derive(Deserialize)]
struct UploadResponse {
    accepted: i64,
    duplicates: i64,
}

// ─── Local state file ───────────────────────────────────────────────────

/// `<app config dir>/enterprise_retention.json` (0600).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionStore {
    /// `"<serverUrl>|<userId>"` → acknowledgedAt (RFC 3339).
    #[serde(default)]
    pub acks: BTreeMap<String, String>,
    /// Logical rollout path (without `.zst`) → cursor.
    #[serde(default)]
    pub cursors: BTreeMap<String, FileCursor>,
    #[serde(default)]
    pub last_upload_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCursor {
    pub session_id: String,
    /// Next seq to upload.
    pub uploaded_seq: u64,
    /// Size / mtime (ms) of the file version whose items were *all* uploaded.
    /// `None` while something is still held back, so the file is re-read.
    #[serde(default)]
    pub file_size: Option<u64>,
    #[serde(default)]
    pub mtime: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileSig {
    pub size: u64,
    pub mtime_ms: i64,
}

pub fn ack_key(server_url: &str, user_id: &str) -> String {
    format!("{server_url}|{user_id}")
}

pub fn state_file_path(config_dir: &Path) -> PathBuf {
    config_dir.join(STATE_FILE)
}

pub fn load_store(path: &Path) -> RetentionStore {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            log::warn!("[Retention] ignoring unreadable state file: {e}");
            RetentionStore::default()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => RetentionStore::default(),
        Err(e) => {
            log::warn!("[Retention] cannot read state file: {e}");
            RetentionStore::default()
        }
    }
}

pub fn save_store(path: &Path, store: &RetentionStore) -> Result<(), String> {
    crate::config::write_json_file_private(path, store).map_err(|e| e.to_string())
}

/// The file is unchanged since every item of it was uploaded.
pub fn cursor_is_current(cursor: Option<&FileCursor>, sig: FileSig) -> bool {
    cursor.is_some_and(|c| c.file_size == Some(sig.size) && c.mtime == Some(sig.mtime_ms))
}

/// Cursor for a file; falls back to the same session under another path
/// (e.g. Codex moved it to `archived_sessions`).
pub fn find_cursor<'a>(
    cursors: &'a BTreeMap<String, FileCursor>,
    key: &str,
    session_id: &str,
) -> Option<&'a FileCursor> {
    cursors
        .get(key)
        .or_else(|| cursors.values().find(|c| c.session_id == session_id))
}

pub fn session_after_ack(created_at_ms: Option<i64>, ack_ms: i64) -> bool {
    created_at_ms.is_some_and(|t| t >= ack_ms)
}

fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.timestamp_millis())
}

fn ms_to_rfc3339(ms: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

// ─── Text helpers ───────────────────────────────────────────────────────

fn floor_char_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    end
}

/// Cut to [`MAX_MESSAGE_CONTENT`] bytes (on a char boundary) and mark it.
pub fn truncate_content(mut s: String) -> String {
    if s.len() <= MAX_MESSAGE_CONTENT {
        return s;
    }
    let end = floor_char_boundary(&s, MAX_MESSAGE_CONTENT);
    s.truncate(end);
    s.push_str(TRUNCATION_SUFFIX);
    s
}

/// Cut to at most `max` UTF-16 code units (the server's zod `max`).
fn truncate_utf16(s: &str, max: usize) -> String {
    let mut units = 0;
    for (idx, ch) in s.char_indices() {
        units += ch.len_utf16();
        if units > max {
            return s[..idx].to_string();
        }
    }
    s.to_string()
}

fn short_field(s: Option<&str>) -> Option<String> {
    s.filter(|s| !s.trim().is_empty())
        .map(|s| truncate_utf16(s, MAX_SHORT_FIELD))
}

// ─── Mapping SessionMessage → RetainedMessage ───────────────────────────

/// Result of mapping a whole rollout.
#[derive(Debug, Clone, PartialEq)]
pub struct MappedConversation {
    pub messages: Vec<RetainedMessage>,
    /// Seq of the first item of the last (non-injected) user prompt.
    pub last_turn_start: Option<u64>,
}

fn role_of(role: &str) -> &'static str {
    match role {
        "user" => "user",
        "assistant" => "assistant",
        "tool" => "tool",
        _ => "system",
    }
}

fn event_label(kind: EventKind) -> &'static str {
    match kind {
        EventKind::Aborted => "aborted",
        EventKind::Compaction => "context compacted",
        EventKind::ModelChange => "model changed",
        EventKind::ThinkingLevel => "thinking level",
        EventKind::Hook => "hook",
        EventKind::PrLink => "pull request",
        EventKind::SlashCommand => "command",
        EventKind::Info => "info",
        EventKind::Error => "error",
        EventKind::SubAgent => "sub-agent",
        EventKind::Other => "event",
    }
}

fn status_label(status: ToolStatus) -> &'static str {
    match status {
        ToolStatus::Success => "success",
        ToolStatus::Error => "error",
        ToolStatus::Interrupted => "interrupted",
        ToolStatus::Pending => "pending",
        ToolStatus::Unknown => "unknown",
    }
}

/// Map parsed Codex messages to upload items (see the module docs for the seq rule).
///
/// `resolve` reads the full text behind a [`ContentRef`] (previews are used when
/// it returns `None`); it is only called for items with `seq >= resolve_from`,
/// since earlier ones were already uploaded and are discarded by the caller.
pub fn map_messages(
    messages: &[SessionMessage],
    resolve_from: u64,
    resolve: &mut dyn FnMut(&ContentRef) -> Option<String>,
) -> MappedConversation {
    let mut out: Vec<RetainedMessage> = Vec::new();
    let mut last_turn_start = None;
    let mut tool_names: HashMap<String, String> = HashMap::new();

    for msg in messages.iter().filter(|m| !m.injected) {
        let role = role_of(&msg.role);
        if role == "user" {
            last_turn_start = Some(out.len() as u64);
        }
        let timestamp = msg.ts.and_then(ms_to_rfc3339);
        let first_item = out.len();
        let mut last_message_item: Option<usize> = None;
        let mut text_group: Vec<String> = Vec::new();

        // Resolve `full` when this item will actually be sent.
        let mut text_of = |preview: &str, full: &Option<ContentRef>, seq: u64| -> String {
            match full {
                Some(r) if seq >= resolve_from => resolve(r).unwrap_or_else(|| preview.to_string()),
                _ => preview.to_string(),
            }
        };

        macro_rules! push_item {
            ($role:expr, $kind:expr, $content:expr, $tool:expr) => {
                out.push(RetainedMessage {
                    seq: out.len() as u64,
                    role: $role,
                    kind: $kind,
                    content: truncate_content($content),
                    tool_name: $tool,
                    timestamp: timestamp.clone(),
                    model: None,
                    input_tokens: None,
                    output_tokens: None,
                })
            };
        }
        macro_rules! flush_text {
            () => {
                if !text_group.is_empty() {
                    let content = text_group.join("\n\n");
                    text_group.clear();
                    last_message_item = Some(out.len());
                    push_item!(role, "message", content, None);
                }
            };
        }

        for block in &msg.blocks {
            let seq = out.len() as u64;
            match block {
                SessionBlock::Text { text, full } => {
                    if !text.trim().is_empty() || full.is_some() {
                        text_group.push(text_of(text, full, seq));
                    }
                }
                SessionBlock::Image { image } => {
                    text_group.push(format!("[image: {}]", image.media_type));
                }
                SessionBlock::Event {
                    kind, text, full, ..
                } => {
                    let label = event_label(*kind);
                    let body = text.as_deref().map(|t| text_of(t, full, seq));
                    text_group.push(match body.filter(|b| !b.trim().is_empty()) {
                        Some(body) => format!("[{label}] {body}"),
                        None => format!("[{label}]"),
                    });
                }
                SessionBlock::Step { .. } => {}
                SessionBlock::Thinking {
                    text,
                    summary,
                    full,
                    ..
                } => {
                    let has_summary = summary.as_deref().is_some_and(|s| !s.trim().is_empty());
                    if text.trim().is_empty() && full.is_none() && !has_summary {
                        // Nothing readable (encrypted reasoning only).
                        continue;
                    }
                    flush_text!();
                    let seq = out.len() as u64;
                    let body = text_of(text, full, seq);
                    let content = match summary.as_deref().filter(|s| !s.trim().is_empty()) {
                        Some(summary) if body.trim().is_empty() => summary.to_string(),
                        Some(summary) => format!("{summary}\n\n{body}"),
                        None => body,
                    };
                    push_item!("assistant", "reasoning", content, None);
                }
                SessionBlock::ToolCall {
                    id,
                    raw_name,
                    input_preview,
                    input_full,
                    ..
                } => {
                    flush_text!();
                    tool_names.insert(id.clone(), raw_name.clone());
                    let seq = out.len() as u64;
                    let args = text_of(input_preview, input_full, seq);
                    let content = if args.trim().is_empty() {
                        raw_name.clone()
                    } else {
                        format!("{raw_name}\n{args}")
                    };
                    push_item!(
                        "assistant",
                        "tool_call",
                        content,
                        short_field(Some(raw_name))
                    );
                }
                SessionBlock::ToolResult {
                    call_id,
                    status,
                    preview,
                    full,
                    exit_code,
                    ..
                } => {
                    flush_text!();
                    let seq = out.len() as u64;
                    let mut content = text_of(preview, full, seq);
                    if content.trim().is_empty() {
                        content = format!("[{}]", status_label(*status));
                    }
                    if let Some(code) = exit_code.filter(|c| *c != 0) {
                        content.push_str(&format!("\n[exit code {code}]"));
                    }
                    // Results split as `call#1`, `call#2` belong to `call`.
                    let base_id = call_id.split('#').next().unwrap_or(call_id);
                    let tool = tool_names
                        .get(call_id)
                        .or_else(|| tool_names.get(base_id))
                        .map(String::as_str);
                    push_item!("tool", "tool_result", content, short_field(tool));
                }
            }
        }
        if msg.blocks.is_empty() && !msg.content.trim().is_empty() {
            text_group.push(msg.content.clone());
        }
        flush_text!();

        if let Some(meta) = &msg.meta {
            let target =
                last_message_item.or_else(|| (out.len() > first_item).then(|| out.len() - 1));
            if let Some(item) = target.and_then(|idx| out.get_mut(idx)) {
                item.model = short_field(meta.model.as_deref());
                item.input_tokens = meta.input_tokens;
                item.output_tokens = meta.output_tokens;
            }
        }
    }

    MappedConversation {
        messages: out,
        last_turn_start,
    }
}

/// Number of leading items that are safe to upload (see "Seq stability").
pub fn settled_len(total: usize, last_turn_start: Option<u64>, idle: bool) -> usize {
    if idle {
        total
    } else {
        (last_turn_start.unwrap_or(0) as usize).min(total)
    }
}

/// Items with `uploaded_seq <= seq < settled`, plus the new cursor value.
pub fn select_pending(
    messages: Vec<RetainedMessage>,
    uploaded_seq: u64,
    settled: usize,
) -> (Vec<RetainedMessage>, u64) {
    let settled = settled as u64;
    let pending: Vec<RetainedMessage> = messages
        .into_iter()
        .filter(|m| m.seq >= uploaded_seq && m.seq < settled)
        .collect();
    (pending, uploaded_seq.max(settled))
}

// ─── Batching ───────────────────────────────────────────────────────────

/// One `items[]` entry plus the cursor update it carries.
#[derive(Debug, Clone)]
pub struct PendingChunk {
    pub upload: ConversationUpload,
    pub cursor_key: String,
    /// `uploadedSeq` after this chunk is accepted.
    pub next_seq: u64,
    /// Set on the last chunk of a file whose items are all being uploaded.
    pub completes_file: Option<FileSig>,
    pub body_bytes: usize,
}

fn json_len<T: Serialize>(value: &T) -> usize {
    serde_json::to_vec(value).map(|v| v.len()).unwrap_or(0)
}

/// Split one conversation into items of ≤ `max_messages` messages and roughly
/// ≤ `max_bytes` serialized bytes. Returns `(upload, serialized size)`.
pub fn chunk_conversation(
    header: &ConversationUpload,
    messages: Vec<RetainedMessage>,
    max_messages: usize,
    max_bytes: usize,
) -> Vec<(ConversationUpload, usize)> {
    let overhead = json_len(header) + 1;
    let mut chunks = Vec::new();
    let mut current: Vec<RetainedMessage> = Vec::new();
    let mut size = overhead;
    for msg in messages {
        let len = json_len(&msg) + 1;
        if !current.is_empty() && (current.len() >= max_messages || size + len > max_bytes) {
            let mut upload = header.clone();
            upload.messages = std::mem::take(&mut current);
            chunks.push((upload, size));
            size = overhead;
        }
        size += len;
        current.push(msg);
    }
    if !current.is_empty() {
        let mut upload = header.clone();
        upload.messages = current;
        chunks.push((upload, size));
    }
    chunks
}

/// Collects chunks into requests of ≤ `max_items` items and ≤ `max_bytes`.
#[derive(Debug)]
pub struct BatchBuilder {
    pending: Vec<PendingChunk>,
    bytes: usize,
    max_items: usize,
    max_bytes: usize,
}

impl BatchBuilder {
    pub fn new(max_items: usize, max_bytes: usize) -> Self {
        Self {
            pending: Vec::new(),
            bytes: 0,
            max_items,
            max_bytes,
        }
    }

    /// Add a chunk; returns the previous batch when this one does not fit.
    pub fn push(&mut self, chunk: PendingChunk) -> Option<Vec<PendingChunk>> {
        let ready = if !self.pending.is_empty()
            && (self.pending.len() >= self.max_items
                || self.bytes + chunk.body_bytes + 16 > self.max_bytes)
        {
            self.bytes = 0;
            Some(std::mem::take(&mut self.pending))
        } else {
            None
        };
        self.bytes += chunk.body_bytes + 1;
        self.pending.push(chunk);
        ready
    }

    pub fn finish(&mut self) -> Option<Vec<PendingChunk>> {
        self.bytes = 0;
        (!self.pending.is_empty()).then(|| std::mem::take(&mut self.pending))
    }
}

/// Apply an accepted batch to the cursors.
pub fn apply_accepted(store: &mut RetentionStore, batch: &[PendingChunk]) {
    for chunk in batch {
        let cursor = store.cursors.entry(chunk.cursor_key.clone()).or_default();
        cursor.session_id = chunk.upload.client_session_id.clone();
        cursor.uploaded_seq = cursor.uploaded_seq.max(chunk.next_seq);
        if let Some(sig) = chunk.completes_file {
            cursor.file_size = Some(sig.size);
            cursor.mtime = Some(sig.mtime_ms);
        }
    }
}

// ─── Candidate selection ────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub path: PathBuf,
    pub cursor_key: String,
    pub session_id: String,
    pub title: Option<String>,
    pub project_dir: Option<String>,
    pub started_at_ms: i64,
    pub sig: FileSig,
    pub uploaded_seq: u64,
    pub idle: bool,
}

pub fn file_sig(path: &Path) -> Option<FileSig> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())?;
    Some(FileSig {
        size: meta.len(),
        mtime_ms,
    })
}

/// Sessions started at/after the acknowledgment whose file changed since it
/// was last fully uploaded.
pub fn select_candidates(
    sessions: Vec<SessionMeta>,
    ack_ms: i64,
    cursors: &BTreeMap<String, FileCursor>,
    now_ms: i64,
    stat: &dyn Fn(&Path) -> Option<FileSig>,
) -> Vec<Candidate> {
    let mut out = Vec::new();
    for meta in sessions {
        if !session_after_ack(meta.created_at, ack_ms) || meta.session_id.is_empty() {
            continue;
        }
        let Some(source) = meta.source_path.as_deref() else {
            continue;
        };
        let path = PathBuf::from(source);
        let Some(sig) = stat(&path) else {
            continue;
        };
        let cursor_key = codex_rollout_file::logical_path(&path)
            .to_string_lossy()
            .into_owned();
        let cursor = find_cursor(cursors, &cursor_key, &meta.session_id);
        if cursor_is_current(cursor, sig) {
            continue;
        }
        let idle = now_ms.saturating_sub(sig.mtime_ms) >= SETTLE_AFTER.as_millis() as i64;
        out.push(Candidate {
            path,
            cursor_key,
            session_id: meta.session_id,
            title: meta.title,
            project_dir: meta.project_dir,
            started_at_ms: meta.created_at.unwrap_or(ack_ms),
            sig,
            uploaded_seq: cursor.map_or(0, |c| c.uploaded_seq),
            idle,
        });
    }
    out
}

/// Load one rollout and build its chunks (blocking IO).
pub(super) fn prepare_candidate(candidate: &Candidate) -> Result<Vec<PendingChunk>, String> {
    let messages = codex::load_messages(&candidate.path)?;
    let path_str = candidate.path.to_string_lossy().into_owned();
    let source = content::validate_source("codex", &path_str).ok();
    let mut resolve = |r: &ContentRef| {
        source
            .as_ref()
            .and_then(|s| content::resolve_content_ref(s, r).ok())
    };
    let mapped = map_messages(&messages, candidate.uploaded_seq, &mut resolve);
    let total = mapped.messages.len();
    let settled = settled_len(total, mapped.last_turn_start, candidate.idle);
    let complete = settled == total;
    let (pending, next_seq) = select_pending(mapped.messages, candidate.uploaded_seq, settled);

    let header = ConversationUpload {
        client_session_id: truncate_utf16(&candidate.session_id, MAX_SESSION_ID),
        title: candidate
            .title
            .as_deref()
            .map(|t| truncate_utf16(t, MAX_TITLE)),
        project_dir: candidate
            .project_dir
            .as_deref()
            .map(|p| truncate_utf16(p, MAX_PROJECT_DIR)),
        started_at: ms_to_rfc3339(candidate.started_at_ms).unwrap_or_else(now_rfc3339),
        messages: Vec::new(),
    };
    let completes_file = complete.then_some(candidate.sig);
    if pending.is_empty() {
        if completes_file.is_none() && next_seq == candidate.uploaded_seq {
            return Ok(Vec::new()); // still running; nothing changed
        }
        // Nothing to send; still record that this file version is done.
        return Ok(vec![PendingChunk {
            upload: header,
            cursor_key: candidate.cursor_key.clone(),
            next_seq,
            completes_file,
            body_bytes: 0,
        }]);
    }
    let chunks = chunk_conversation(
        &header,
        pending,
        MAX_MESSAGES_PER_ITEM,
        MAX_BODY_BYTES - 1024,
    );
    let count = chunks.len();
    Ok(chunks
        .into_iter()
        .enumerate()
        .map(|(i, (upload, body_bytes))| {
            let last = i + 1 == count;
            let chunk_next = if last {
                next_seq
            } else {
                upload.messages.last().map_or(next_seq, |m| m.seq + 1)
            };
            PendingChunk {
                upload,
                cursor_key: candidate.cursor_key.clone(),
                next_seq: chunk_next,
                completes_file: if last { completes_file } else { None },
                body_bytes,
            }
        })
        .collect())
}

// ─── Service ────────────────────────────────────────────────────────────

/// Status exposed to the webview.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetentionStatus {
    pub enabled: bool,
    pub notice_text: String,
    pub acknowledged: bool,
    pub acknowledged_at: Option<String>,
    pub last_upload_at: Option<String>,
    pub last_error: Option<String>,
    pub uploaded_sessions: usize,
}

struct UploadContext {
    ack_key: String,
}

fn upload_context(state: &EnterpriseState) -> Option<UploadContext> {
    if !state.logged_in {
        return None;
    }
    let config = state.config.as_ref()?;
    if !config.retention.enabled {
        return None;
    }
    let server = state.server_url.as_deref()?;
    let user = state
        .user
        .as_ref()
        .map(|u| u.id.as_str())
        .unwrap_or(&config.user.id);
    Some(UploadContext {
        ack_key: ack_key(server, user),
    })
}

pub struct RetentionService {
    session: Arc<EnterpriseSession>,
    state_path: PathBuf,
    store: Mutex<RetentionStore>,
    last_error: Mutex<Option<String>>,
    wake: Notify,
    run_lock: tokio::sync::Mutex<()>,
}

impl RetentionService {
    pub fn new(session: Arc<EnterpriseSession>, config_dir: PathBuf) -> Arc<Self> {
        let state_path = state_file_path(&config_dir);
        let store = load_store(&state_path);
        Arc::new(Self {
            session,
            state_path,
            store: Mutex::new(store),
            last_error: Mutex::new(None),
            wake: Notify::new(),
            run_lock: tokio::sync::Mutex::new(()),
        })
    }

    /// Run an upload pass as soon as possible.
    pub fn trigger(&self) {
        self.wake.notify_one();
    }

    fn store(&self) -> std::sync::MutexGuard<'_, RetentionStore> {
        self.store.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_error(&self, error: Option<String>) {
        *self.last_error.lock().unwrap_or_else(|e| e.into_inner()) = error;
    }

    fn persist(&self) {
        let snapshot = self.store().clone();
        if let Err(e) = save_store(&self.state_path, &snapshot) {
            log::warn!("[Retention] failed to save state: {e}");
        }
    }

    pub async fn status(&self) -> RetentionStatus {
        let state = self.session.state().await;
        let policy = state
            .config
            .as_ref()
            .filter(|_| state.logged_in)
            .map(|c| c.retention.clone());
        let enabled = policy.as_ref().is_some_and(|p| p.enabled);
        let ack =
            upload_context(&state).and_then(|ctx| self.store().acks.get(&ctx.ack_key).cloned());
        let store = self.store();
        RetentionStatus {
            enabled,
            notice_text: policy.map(|p| p.notice_text).unwrap_or_default(),
            acknowledged: ack.is_some(),
            acknowledged_at: ack,
            last_upload_at: store.last_upload_at.clone(),
            last_error: self
                .last_error
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            uploaded_sessions: store
                .cursors
                .values()
                .filter(|c| c.uploaded_seq > 0)
                .count(),
        }
    }

    /// Record the upload cutoff for the current server + user and upload right away.
    pub async fn acknowledge(&self) -> Result<RetentionStatus, String> {
        let state = self.session.state().await;
        let ctx = upload_context(&state)
            .ok_or_else(|| "Conversation retention is not enabled for this account".to_string())?;
        let changed = {
            let mut store = self.store();
            if store.acks.contains_key(&ctx.ack_key) {
                false
            } else {
                store.acks.insert(ctx.ack_key.clone(), now_rfc3339());
                true
            }
        };
        if changed {
            let snapshot = self.store().clone();
            save_store(&self.state_path, &snapshot)?;
            log::info!("[Retention] cutoff recorded");
        }
        self.trigger();
        Ok(self.status().await)
    }

    /// Background loop: first pass after [`FIRST_TICK`], then every [`TICK`] or on [`Self::trigger`].
    pub async fn run_loop(self: Arc<Self>) {
        tokio::select! {
            _ = tokio::time::sleep(FIRST_TICK) => {}
            _ = self.wake.notified() => {}
        }
        loop {
            self.run_once().await;
            tokio::select! {
                _ = tokio::time::sleep(TICK) => {}
                _ = self.wake.notified() => {}
            }
        }
    }

    async fn run_once(&self) {
        let _running = self.run_lock.lock().await;
        let state = self.session.state().await;
        let Some(ctx) = upload_context(&state) else {
            return;
        };
        // Drop the store lock before acknowledge(); that call locks it again.
        let needs_cutoff = !self.store().acks.contains_key(&ctx.ack_key);
        if needs_cutoff {
            // The consent dialog is gone. The cutoff is the first time this
            // device applies the enabled policy; sessions started earlier stay local.
            if let Err(e) = self.acknowledge().await {
                log::warn!("[Retention] failed to record cutoff: {e}");
                return;
            }
        }
        let Some(ack_ms) = self
            .store()
            .acks
            .get(&ctx.ack_key)
            .and_then(|s| parse_rfc3339_ms(s))
        else {
            return;
        };

        let cursors = self.store().cursors.clone();
        let scanned = tokio::task::spawn_blocking(move || {
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let sessions = codex::scan_sessions();
            let candidates = select_candidates(sessions, ack_ms, &cursors, now_ms, &file_sig);
            // Forget cursors of rollouts that no longer exist in either form.
            let stale: Vec<String> = cursors
                .keys()
                .filter(|key| {
                    let path = Path::new(key.as_str());
                    !path.exists() && !codex_rollout_file::sibling(path).is_some_and(|s| s.exists())
                })
                .cloned()
                .collect();
            (candidates, stale)
        })
        .await;
        let (candidates, stale) = match scanned {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[Retention] scan task failed: {e}");
                return;
            }
        };
        if !stale.is_empty() {
            let mut store = self.store();
            for key in &stale {
                store.cursors.remove(key);
            }
        }

        let mut builder = BatchBuilder::new(MAX_ITEMS_PER_REQUEST, MAX_BODY_BYTES);
        let mut dirty = !stale.is_empty();
        for candidate in candidates {
            let prepared = tokio::task::spawn_blocking(move || prepare_candidate(&candidate)).await;
            let chunks = match prepared {
                Ok(Ok(chunks)) => chunks,
                Ok(Err(e)) => {
                    log::debug!("[Retention] skipping unreadable rollout: {e}");
                    continue;
                }
                Err(e) => {
                    log::warn!("[Retention] prepare task failed: {e}");
                    continue;
                }
            };
            for chunk in chunks {
                if chunk.upload.messages.is_empty() {
                    apply_accepted(&mut self.store(), std::slice::from_ref(&chunk));
                    dirty = true;
                    continue;
                }
                if let Some(batch) = builder.push(chunk) {
                    if !self.upload(&batch).await {
                        self.persist();
                        return;
                    }
                    dirty = false;
                }
            }
        }
        if let Some(batch) = builder.finish() {
            if !self.upload(&batch).await {
                self.persist();
                return;
            }
            dirty = false;
        }
        if dirty {
            self.persist();
        }
        self.set_error(None);
    }

    /// Send one request; on 2xx advance the cursors and persist. Returns success.
    async fn upload(&self, batch: &[PendingChunk]) -> bool {
        let body = match serde_json::to_vec(&UploadRequest {
            items: batch.iter().map(|c| &c.upload).collect(),
        }) {
            Ok(body) => body,
            Err(e) => {
                log::warn!("[Retention] failed to encode upload: {e}");
                return false;
            }
        };
        let message_count: usize = batch.iter().map(|c| c.upload.messages.len()).sum();
        let result = self
            .session
            .send_authenticated(|http, base, token| {
                http.post(client::endpoint(base, UPLOAD_PATH))
                    .bearer_auth(token)
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .timeout(UPLOAD_TIMEOUT)
                    .body(body.clone())
            })
            .await;
        let response = match result {
            Ok((_, resp)) => client::decode_json::<UploadResponse>(resp).await,
            Err(e) => Err(e),
        };
        match response {
            Ok(res) => {
                {
                    let mut store = self.store();
                    apply_accepted(&mut store, batch);
                    store.last_upload_at = Some(now_rfc3339());
                }
                self.persist();
                log::info!(
                    "[Retention] uploaded {} conversation chunk(s), {message_count} message(s): accepted {}, duplicates {}",
                    batch.len(),
                    res.accepted,
                    res.duplicates
                );
                true
            }
            Err(e) => {
                let forbidden = matches!(e, EnterpriseError::Api { status: 403, .. });
                if forbidden {
                    log::info!("[Retention] upload refused by policy (403); waiting for next tick");
                } else {
                    log::warn!("[Retention] upload failed, will retry: {e}");
                }
                self.set_error(Some(e.to_string()));
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_manager::model::{MessageMeta, ToolKind};

    fn msg(role: &str, blocks: Vec<SessionBlock>) -> SessionMessage {
        SessionMessage::from_blocks(role, Some(1_700_000_000_000), blocks)
    }

    fn thinking(text: &str) -> SessionBlock {
        SessionBlock::Thinking {
            text: text.into(),
            summary: None,
            redacted: false,
            duration_ms: None,
            full: None,
        }
    }

    fn call(id: &str, name: &str, args: &str) -> SessionBlock {
        SessionBlock::ToolCall {
            id: id.into(),
            raw_name: name.into(),
            kind: ToolKind::Shell,
            title: args.into(),
            detail: None,
            server: None,
            input_preview: args.into(),
            input_total_len: args.len() as u32,
            input_full: None,
            diff: None,
            by_user: false,
        }
    }

    fn result(call_id: &str, out: &str, full: Option<ContentRef>) -> SessionBlock {
        SessionBlock::ToolResult {
            call_id: call_id.into(),
            status: ToolStatus::Success,
            preview: out.into(),
            total_len: out.len() as u32,
            line_count: 1,
            truncated: full.is_some(),
            full,
            exit_code: None,
            duration_ms: None,
            images: Vec::new(),
            saved_path: None,
        }
    }

    fn jsonl_ref() -> ContentRef {
        ContentRef::Jsonl {
            offset: 0,
            len: 1,
            pointer: "/payload/output".into(),
        }
    }

    fn sample() -> Vec<SessionMessage> {
        let mut injected = msg("user", vec![SessionBlock::text("# AGENTS.md instructions")]);
        injected.injected = true;
        let mut answer = msg("assistant", vec![SessionBlock::text("done")]);
        answer.meta = Some(MessageMeta {
            model: Some("gpt-5".into()),
            input_tokens: Some(10),
            output_tokens: Some(5),
            ..MessageMeta::default()
        });
        vec![
            injected,
            msg("user", vec![SessionBlock::text("list files")]),
            msg(
                "assistant",
                vec![
                    thinking("plan"),
                    call("c1", "exec_command", "{\"cmd\":\"ls\"}"),
                ],
            ),
            msg("tool", vec![result("c1", "a.txt", Some(jsonl_ref()))]),
            answer,
            msg("user", vec![SessionBlock::text("next")]),
            msg("assistant", vec![thinking("")]),
        ]
    }

    #[test]
    fn maps_messages_with_stable_seq() {
        let mut resolved = 0;
        let mapped = map_messages(&sample(), 0, &mut |_| {
            resolved += 1;
            Some("a.txt\nb.txt".into())
        });
        let kinds: Vec<_> = mapped
            .messages
            .iter()
            .map(|m| (m.seq, m.role, m.kind))
            .collect();
        assert_eq!(
            kinds,
            vec![
                (0, "user", "message"),
                (1, "assistant", "reasoning"),
                (2, "assistant", "tool_call"),
                (3, "tool", "tool_result"),
                (4, "assistant", "message"),
                (5, "user", "message"),
            ]
        );
        assert_eq!(resolved, 1);
        let m = &mapped.messages;
        assert_eq!(m[2].content, "exec_command\n{\"cmd\":\"ls\"}");
        assert_eq!(m[2].tool_name.as_deref(), Some("exec_command"));
        assert_eq!(m[3].content, "a.txt\nb.txt");
        assert_eq!(m[3].tool_name.as_deref(), Some("exec_command"));
        assert_eq!(m[4].model.as_deref(), Some("gpt-5"));
        assert_eq!((m[4].input_tokens, m[4].output_tokens), (Some(10), Some(5)));
        assert_eq!(m[0].timestamp.as_deref(), Some("2023-11-14T22:13:20.000Z"));
        assert_eq!(mapped.last_turn_start, Some(5));

        // Growing the rollout keeps earlier seqs; already-sent items are not resolved.
        let mut grown = sample();
        grown.push(msg("assistant", vec![SessionBlock::text("more")]));
        let mut resolved_again = 0;
        let again = map_messages(&grown, 4, &mut |_| {
            resolved_again += 1;
            None
        });
        assert_eq!(resolved_again, 0);
        assert_eq!(again.messages[..3], mapped.messages[..3]);
        assert_eq!(again.messages.len(), 7);
        assert_eq!(again.messages[3].content, "a.txt");
    }

    #[test]
    fn truncates_content_on_char_boundary() {
        assert_eq!(truncate_content("short".into()), "short");
        let long = "é".repeat(MAX_MESSAGE_CONTENT); // 2 bytes each
        let cut = truncate_content(long);
        assert!(cut.ends_with(TRUNCATION_SUFFIX));
        assert!(cut.len() <= MAX_MESSAGE_CONTENT + TRUNCATION_SUFFIX.len());
        assert!(cut.encode_utf16().count() <= MAX_MESSAGE_CONTENT + 64);
        assert_eq!(truncate_utf16("ab😀c", 3), "ab");
        assert_eq!(truncate_utf16("ab😀c", 4), "ab😀");
    }

    #[test]
    fn settled_and_pending_selection() {
        assert_eq!(settled_len(6, Some(5), false), 5);
        assert_eq!(settled_len(6, Some(5), true), 6);
        assert_eq!(settled_len(6, None, false), 0);
        let mapped = map_messages(&sample(), 0, &mut |_| None);
        let (pending, next) = select_pending(mapped.messages.clone(), 2, 5);
        assert_eq!(
            pending.iter().map(|m| m.seq).collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
        assert_eq!(next, 5);
        let (pending, next) = select_pending(mapped.messages, 5, 3);
        assert!(pending.is_empty());
        assert_eq!(next, 5);
    }

    fn header() -> ConversationUpload {
        ConversationUpload {
            client_session_id: "s1".into(),
            title: Some("t".into()),
            project_dir: None,
            started_at: "2026-01-01T00:00:00.000Z".into(),
            messages: Vec::new(),
        }
    }

    fn retained(seq: u64, content: &str) -> RetainedMessage {
        RetainedMessage {
            seq,
            role: "user",
            kind: "message",
            content: content.into(),
            tool_name: None,
            timestamp: None,
            model: None,
            input_tokens: None,
            output_tokens: None,
        }
    }

    #[test]
    fn chunks_respect_count_and_size() {
        let msgs: Vec<_> = (0..4500).map(|i| retained(i, "x")).collect();
        let chunks = chunk_conversation(&header(), msgs, MAX_MESSAGES_PER_ITEM, MAX_BODY_BYTES);
        let sizes: Vec<_> = chunks.iter().map(|(c, _)| c.messages.len()).collect();
        assert_eq!(sizes, vec![2000, 2000, 500]);
        assert_eq!(chunks[1].0.messages[0].seq, 2000);

        let big = "y".repeat(1000);
        let msgs: Vec<_> = (0..10).map(|i| retained(i, &big)).collect();
        let chunks = chunk_conversation(&header(), msgs, 2000, 3500);
        assert!(chunks.len() >= 4);
        for (upload, size) in &chunks {
            assert!(*size <= 3500);
            assert!(serde_json::to_vec(upload).unwrap().len() <= *size);
        }
    }

    fn pending_chunk(bytes: usize) -> PendingChunk {
        PendingChunk {
            upload: header(),
            cursor_key: "k".into(),
            next_seq: 1,
            completes_file: None,
            body_bytes: bytes,
        }
    }

    #[test]
    fn batches_respect_item_and_byte_limits() {
        let mut builder = BatchBuilder::new(MAX_ITEMS_PER_REQUEST, 1000);
        let mut batches = Vec::new();
        for _ in 0..120 {
            if let Some(b) = builder.push(pending_chunk(10)) {
                batches.push(b.len());
            }
        }
        batches.extend(builder.finish().map(|b| b.len()));
        assert_eq!(batches, vec![50, 50, 20]);

        let mut builder = BatchBuilder::new(50, 1000);
        assert!(builder.push(pending_chunk(600)).is_none());
        assert_eq!(builder.push(pending_chunk(600)).map(|b| b.len()), Some(1));
        assert_eq!(builder.finish().map(|b| b.len()), Some(1));
        assert!(builder.finish().is_none());
    }

    #[test]
    fn cursor_skip_and_apply() {
        let sig = FileSig {
            size: 100,
            mtime_ms: 5,
        };
        assert!(!cursor_is_current(None, sig));
        let mut store = RetentionStore::default();
        let mut chunk = pending_chunk(10);
        chunk.next_seq = 7;
        apply_accepted(&mut store, std::slice::from_ref(&chunk));
        assert_eq!(store.cursors["k"].uploaded_seq, 7);
        assert!(!cursor_is_current(store.cursors.get("k"), sig));
        chunk.next_seq = 3; // never moves backwards
        chunk.completes_file = Some(sig);
        apply_accepted(&mut store, std::slice::from_ref(&chunk));
        assert_eq!(store.cursors["k"].uploaded_seq, 7);
        assert!(cursor_is_current(store.cursors.get("k"), sig));
        assert!(!cursor_is_current(
            store.cursors.get("k"),
            FileSig {
                size: 101,
                mtime_ms: 5
            }
        ));
        // Same session under another path inherits the cursor.
        assert_eq!(
            find_cursor(&store.cursors, "other", "s1").map(|c| c.uploaded_seq),
            Some(7)
        );
        assert!(find_cursor(&store.cursors, "other", "s2").is_none());
    }

    fn meta(id: &str, created_at: Option<i64>, path: &str) -> SessionMeta {
        SessionMeta {
            provider_id: "codex".into(),
            session_id: id.into(),
            title: None,
            summary: None,
            project_dir: None,
            created_at,
            last_active_at: None,
            source_path: Some(path.into()),
            resume_command: None,
        }
    }

    #[test]
    fn only_sessions_after_ack_are_candidates() {
        let ack = 1_000_000;
        assert!(session_after_ack(Some(ack), ack));
        assert!(!session_after_ack(Some(ack - 1), ack));
        assert!(!session_after_ack(None, ack));

        let sig = FileSig {
            size: 10,
            mtime_ms: ack + 10,
        };
        let mut cursors = BTreeMap::new();
        cursors.insert(
            "/r/done.jsonl".to_string(),
            FileCursor {
                session_id: "done".into(),
                uploaded_seq: 4,
                file_size: Some(10),
                mtime: Some(ack + 10),
            },
        );
        let sessions = vec![
            meta("old", Some(ack - 1), "/r/old.jsonl"),
            meta("new", Some(ack + 1), "/r/new.jsonl.zst"),
            meta("done", Some(ack + 1), "/r/done.jsonl"),
            meta("unknown", None, "/r/unknown.jsonl"),
        ];
        let now = ack + 10 + SETTLE_AFTER.as_millis() as i64;
        let got = select_candidates(sessions, ack, &cursors, now, &|_| Some(sig));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].session_id, "new");
        assert_eq!(got[0].cursor_key, "/r/new.jsonl");
        assert!(got[0].idle);
        assert_eq!(got[0].uploaded_seq, 0);
    }

    #[test]
    fn store_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_file_path(dir.path());
        assert_eq!(load_store(&path), RetentionStore::default());
        let mut store = RetentionStore::default();
        store.acks.insert(
            ack_key("https://e.example", "u1"),
            "2026-01-01T00:00:00.000Z".into(),
        );
        store.cursors.insert(
            "/r/a.jsonl".into(),
            FileCursor {
                session_id: "a".into(),
                uploaded_seq: 3,
                file_size: Some(9),
                mtime: Some(8),
            },
        );
        store.last_upload_at = Some("2026-01-02T00:00:00.000Z".into());
        save_store(&path, &store).unwrap();
        assert_eq!(load_store(&path), store);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(
            parse_rfc3339_ms(&store.acks["https://e.example|u1"]),
            Some(1_767_225_600_000)
        );
        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(load_store(&path), RetentionStore::default());
    }
    #[test]
    fn real_rollout_seq_is_stable_when_file_grows() {
        let line = |ty: &str, payload: serde_json::Value| {
            serde_json::json!({
                "timestamp": "2026-01-01T00:00:00.000Z",
                "type": ty,
                "payload": payload,
            })
            .to_string()
        };
        let user = |text: &str| {
            line(
                "response_item",
                serde_json::json!({"type": "message", "role": "user",
                    "content": [{"type": "input_text", "text": text}]}),
            )
        };
        let first = vec![
            line("session_meta", serde_json::json!({"id": "s1", "cwd": "/p"})),
            line(
                "turn_context",
                serde_json::json!({"turn_id": "t1", "model": "gpt-5"}),
            ),
            user("# AGENTS.md instructions for /p"),
            user("list files"),
            line(
                "response_item",
                serde_json::json!({"type": "reasoning",
                    "summary": [{"type": "summary_text", "text": "plan"}]}),
            ),
            line(
                "response_item",
                serde_json::json!({"type": "function_call", "name": "exec_command",
                    "arguments": "{\"cmd\":\"ls\"}", "call_id": "c1"}),
            ),
        ];
        let second = vec![
            line(
                "response_item",
                serde_json::json!({"type": "function_call_output", "call_id": "c1",
                    "output": "a.txt"}),
            ),
            line(
                "response_item",
                serde_json::json!({"type": "message", "role": "assistant",
                    "content": [{"type": "output_text", "text": "done"}]}),
            ),
            line(
                "turn_context",
                serde_json::json!({"turn_id": "t2", "model": "gpt-5"}),
            ),
            user("next"),
        ];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        std::fs::write(&path, first.join("\n") + "\n").unwrap();
        let before = map_messages(&codex::load_messages(&path).unwrap(), 0, &mut |_| None);
        std::fs::write(&path, [first, second].concat().join("\n") + "\n").unwrap();
        let after = map_messages(&codex::load_messages(&path).unwrap(), 0, &mut |_| None);

        assert!(before
            .messages
            .iter()
            .all(|m| !m.content.contains("AGENTS.md")));
        assert_eq!(before.messages[0].content, "list files");
        assert!(after.messages.len() > before.messages.len());
        let strip = |m: &RetainedMessage| (m.seq, m.role, m.kind, m.content.clone());
        let b: Vec<_> = before.messages.iter().map(strip).collect();
        let a: Vec<_> = after.messages[..b.len()].iter().map(strip).collect();
        assert_eq!(a, b);
        let kinds: Vec<_> = after.messages.iter().map(|m| m.kind).collect();
        assert_eq!(
            kinds,
            vec![
                "message",
                "reasoning",
                "tool_call",
                "tool_result",
                "message",
                "message"
            ]
        );
        assert_eq!(after.messages[3].tool_name.as_deref(), Some("exec_command"));
        assert_eq!(after.last_turn_start, Some(5));
    }
}

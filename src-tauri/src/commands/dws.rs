//! DingTalk Workspace CLI (`dws`) connector: status, install, login.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};

const INSTALL_SH: &str =
    "https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.sh";
const INSTALL_PS1: &str =
    "https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.ps1";
const INSTALL_TIMEOUT: Duration = Duration::from_secs(480);
const STATUS_TIMEOUT: Duration = Duration::from_secs(20);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DwsStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub logged_in: bool,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn candidate_bins() -> Vec<PathBuf> {
    let exe = if cfg!(windows) { "dws.exe" } else { "dws" };
    let mut out = Vec::new();
    if let Some(home) = home_dir() {
        out.push(home.join(".local").join("bin").join(exe));
        out.push(home.join("bin").join(exe));
    }
    out
}

fn looks_like_dws(path: &Path) -> bool {
    path.is_file()
}

fn which_dws() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let where_exe = PathBuf::from(
            std::env::var_os("SystemRoot").unwrap_or_else(|| std::ffi::OsString::from(r"C:\Windows")),
        )
        .join("System32")
        .join("where.exe");
        let mut cmd = Command::new(where_exe);
        cmd.arg("$PATH:dws")
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = cmd.output().ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let first = text.lines().map(str::trim).find(|l| !l.is_empty())?;
        let p = PathBuf::from(first);
        if looks_like_dws(&p) {
            return Some(p);
        }
        None
    }
    #[cfg(not(windows))]
    {
        let output = Command::new("/bin/sh")
            .args(["-c", "command -v dws"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let first = text.lines().map(str::trim).find(|l| l.starts_with('/'))?;
        let p = PathBuf::from(first);
        if looks_like_dws(&p) {
            Some(p)
        } else {
            None
        }
    }
}

fn find_dws() -> Option<PathBuf> {
    candidate_bins()
        .into_iter()
        .find(|p| looks_like_dws(p))
        .or_else(which_dws)
}

fn run_dws(bin: &Path, args: &[&str], timeout: Duration) -> Result<std::process::Output, String> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    wait_output(cmd, timeout)
}

fn parse_version(stdout: &str) -> Option<String> {
    let line = stdout.lines().map(str::trim).find(|l| !l.is_empty())?;
    let trimmed = line
        .strip_prefix("dws")
        .unwrap_or(line)
        .trim()
        .trim_start_matches("version")
        .trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_logged_in(stdout: &str) -> bool {
    let text = stdout.trim();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
        return v.get("authenticated").and_then(|x| x.as_bool()) == Some(true);
    }
    // Some builds wrap JSON in extra lines.
    for line in stdout.lines().rev() {
        let line = line.trim();
        if line.starts_with('{') {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                return v.get("authenticated").and_then(|x| x.as_bool()) == Some(true);
            }
        }
    }
    false
}

fn probe(bin: &Path) -> DwsStatus {
    let version = run_dws(bin, &["version"], STATUS_TIMEOUT)
        .ok()
        .and_then(|o| parse_version(&String::from_utf8_lossy(&o.stdout)));
    let logged_in = run_dws(
        bin,
        &["auth", "status", "--readonly", "--format", "json"],
        STATUS_TIMEOUT,
    )
    .ok()
    .map(|o| parse_logged_in(&String::from_utf8_lossy(&o.stdout)))
    .unwrap_or(false);
    DwsStatus {
        installed: true,
        version,
        path: Some(bin.display().to_string()),
        logged_in,
    }
}

fn not_installed() -> DwsStatus {
    DwsStatus {
        installed: false,
        version: None,
        path: None,
        logged_in: false,
    }
}

pub fn is_installed() -> bool {
    find_dws().is_some()
}

pub fn install_blocking() -> Result<DwsStatus, String> {
    run_installer()?;
    find_dws()
        .map(|bin| probe(&bin))
        .ok_or_else(|| "安装完成但找不到 dws，请重新打开本应用后再试".to_string())
}

#[tauri::command]
pub async fn dws_status() -> Result<DwsStatus, String> {
    Ok(match find_dws() {
        Some(bin) => probe(&bin),
        None => not_installed(),
    })
}

fn run_installer() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let script = format!(
            "$ErrorActionPreference='Stop'; $env:DWS_SKILL_MODE='multi'; Invoke-RestMethod -Uri '{INSTALL_PS1}' | Invoke-Expression"
        );
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let output = wait_output(cmd, INSTALL_TIMEOUT)?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let out = String::from_utf8_lossy(&output.stdout);
            return Err(format!(
                "安装失败：{}",
                first_line(&err)
                    .or_else(|| first_line(&out))
                    .unwrap_or_else(|| "未知错误".into())
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let script = format!(
            "export DWS_SKILL_MODE=multi; curl -fsSL '{INSTALL_SH}' | sh"
        );
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", &script])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = wait_output(cmd, INSTALL_TIMEOUT)?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let out = String::from_utf8_lossy(&output.stdout);
            return Err(format!(
                "安装失败：{}",
                first_line(&err)
                    .or_else(|| first_line(&out))
                    .unwrap_or_else(|| "未知错误".into())
            ));
        }
        Ok(())
    }
}

fn wait_output(mut cmd: Command, timeout: Duration) -> Result<std::process::Output, String> {
    use std::io::Read;
    let mut child = cmd.spawn().map_err(|e| format!("无法启动进程：{e}"))?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                if let Some(mut s) = child.stdout.take() {
                    let _ = s.read_to_end(&mut stdout);
                }
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_end(&mut stderr);
                }
                return Ok(std::process::Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                return Err("安装超时，请检查网络后重试".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(80)),
            Err(e) => return Err(format!("等待进程失败：{e}")),
        }
    }
}

fn first_line(s: &str) -> Option<String> {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(240).collect())
}

#[tauri::command]
pub async fn dws_install() -> Result<DwsStatus, String> {
    tokio::task::spawn_blocking(install_blocking)
        .await
        .map_err(|e| format!("安装任务中断：{e}"))?
}

#[tauri::command]
pub async fn dws_open_login() -> Result<(), String> {
    let bin = find_dws().ok_or_else(|| "尚未安装 DingTalk Workspace CLI".to_string())?;
    #[cfg(windows)]
    {
        let quoted = bin.display().to_string().replace('\'', "''");
        let ps = format!("& '{quoted}' auth login");
        Command::new("cmd")
            .args(["/C", "start", "dws login", "powershell", "-NoExit", "-Command", &ps])
            .spawn()
            .map_err(|e| format!("无法打开登录窗口：{e}"))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "tell application \"Terminal\" to do script {}",
            serde_json::to_string(&format!("{} auth login", bin.display()))
                .unwrap_or_else(|_| "\"dws auth login\"".into())
        );
        Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("无法打开终端登录：{e}"))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let cmd = format!("{} auth login; echo; read -p '按回车关闭…'", bin.display());
        for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            if Command::new(term).args(["-e", "sh", "-c", &cmd]).spawn().is_ok() {
                return Ok(());
            }
        }
        Err("找不到可用终端，请手动运行 dws auth login".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_logged_in, parse_version};

    #[test]
    fn parses_version_line() {
        assert_eq!(
            parse_version("dws version 1.0.63\n"),
            Some("1.0.63".into())
        );
        assert_eq!(parse_version("1.0.63\n"), Some("1.0.63".into()));
    }

    #[test]
    fn parses_auth_json() {
        assert!(parse_logged_in(r#"{"authenticated":true}"#));
        assert!(!parse_logged_in(r#"{"authenticated":false}"#));
        assert!(!parse_logged_in("not json"));
    }
}

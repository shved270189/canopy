use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub worktrees: Vec<String>,
}


#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub has_changes: bool,
    pub has_stash: bool,
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let (code, stdout, stderr) = git_output(repo, args)?;
    if code != 0 {
        return Err(if stderr.is_empty() {
            "git command failed".into()
        } else {
            stderr
        });
    }
    Ok(stdout)
}

fn git_output(repo: &Path, args: &[&str]) -> Result<(i32, String, String), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;

    let code = output.status.code().unwrap_or(1);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Ok((code, stdout, stderr))
}

/// Diff commands exit 1 when differences exist.
fn git_diff(repo: &Path, args: &[&str]) -> Result<String, String> {
    let (code, stdout, stderr) = git_output(repo, args)?;
    if code == 0 || code == 1 {
        return Ok(stdout);
    }
    Err(if stderr.is_empty() {
        "git diff failed".into()
    } else {
        stderr
    })
}


fn worktree_has_changes(path: &Path) -> bool {
    git(path, &["status", "--porcelain", "--untracked-files=normal"])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false)
}

fn parse_stash_branch(line: &str) -> Option<String> {
    let message = line.split_once(": ")?.1;
    if let Some(rest) = message.strip_prefix("WIP on ") {
        return rest.split_once(':').map(|(b, _)| b.trim().to_string());
    }
    if let Some(rest) = message.strip_prefix("On ") {
        return rest.split_once(':').map(|(b, _)| b.trim().to_string());
    }
    None
}

fn stash_branches(repo: &Path) -> Vec<String> {
    git(repo, &["stash", "list"])
        .unwrap_or_default()
        .lines()
        .filter_map(parse_stash_branch)
        .collect()
}

fn worktree_has_stash(branch: &Option<String>, stashed_on: &[String]) -> bool {
    match branch {
        Some(name) => stashed_on.iter().any(|b| b == name),
        None => false,
    }
}


fn path_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

fn short_branch(branch: &str) -> String {
    branch
        .strip_prefix("refs/heads/")
        .unwrap_or(branch)
        .to_string()
}

fn parse_worktrees(porcelain: &str) -> Vec<WorktreeInfo> {
    let mut worktrees = Vec::new();
    let mut path: Option<String> = None;
    let mut head: Option<String> = None;
    let mut branch: Option<String> = None;

    let flush = |worktrees: &mut Vec<WorktreeInfo>,
                 path: &mut Option<String>,
                 head: &mut Option<String>,
                 branch: &mut Option<String>| {
        if let Some(wt_path) = path.take() {
            let name = branch
                .as_ref()
                .map(|b| short_branch(b))
                .unwrap_or_else(|| path_name(&wt_path));
            worktrees.push(WorktreeInfo {
                path: wt_path,
                name,
                branch: branch.take().map(|b| short_branch(&b)),
                head: head.take(),
                has_changes: false,
                has_stash: false,
            });
        } else {
            *head = None;
            *branch = None;
        }
    };

    for line in porcelain.lines() {
        if line.is_empty() {
            flush(&mut worktrees, &mut path, &mut head, &mut branch);
            continue;
        }

        if let Some(rest) = line.strip_prefix("worktree ") {
            flush(&mut worktrees, &mut path, &mut head, &mut branch);
            path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            head = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("branch ") {
            branch = Some(rest.to_string());
        } else if line == "detached" {
            branch = None;
        }
    }

    flush(&mut worktrees, &mut path, &mut head, &mut branch);
    worktrees
}

fn enrich_worktree_status(worktrees: &mut [WorktreeInfo], repo: &Path) {
    let stashed_on = stash_branches(repo);
    let paths: Vec<PathBuf> = worktrees
        .iter()
        .map(|wt| PathBuf::from(&wt.path))
        .collect();

    let dirty: Vec<bool> = std::thread::scope(|scope| {
        let handles: Vec<_> = paths
            .iter()
            .map(|path| scope.spawn(|| worktree_has_changes(path)))
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap_or(false))
            .collect()
    });

    for (wt, has_changes) in worktrees.iter_mut().zip(dirty) {
        wt.has_changes = has_changes;
        wt.has_stash = worktree_has_stash(&wt.branch, &stashed_on);
    }
}

fn list_worktrees_basic(path: &Path) -> Result<Vec<WorktreeInfo>, String> {
    let porcelain = git(path, &["worktree", "list", "--porcelain"])?;
    Ok(parse_worktrees(&porcelain))
}

#[tauri::command]
fn validate_project(path: String) -> Result<ProjectInfo, String> {
    let repo = PathBuf::from(&path);
    if !repo.is_dir() {
        return Err("path is not a directory".into());
    }

    let inside = git(&repo, &["rev-parse", "--is-inside-work-tree"])?;
    if inside.trim() != "true" {
        return Err("directory is not a git repository".into());
    }

    Ok(ProjectInfo {
        name: path_name(&path),
        path,
        worktrees: Vec::new(),
    })
}

/// Fast: worktree names/paths only (no status).
#[tauri::command]
fn list_worktrees(path: String) -> Result<Vec<WorktreeInfo>, String> {
    list_worktrees_basic(&PathBuf::from(path))
}

/// Slower: full list with dirty/stash flags (status checks run in parallel).
#[tauri::command]
fn list_worktrees_with_status(path: String) -> Result<Vec<WorktreeInfo>, String> {
    let repo = PathBuf::from(&path);
    let mut worktrees = list_worktrees_basic(&repo)?;
    enrich_worktree_status(&mut worktrees, &repo);
    Ok(worktrees)
}

/// Remove a linked worktree from the repo (`git worktree remove`).
#[tauri::command]
fn remove_worktree(repo: String, path: String, force: bool) -> Result<(), String> {
    let repo_path = PathBuf::from(&repo);
    let wt_path = PathBuf::from(&path);

    if !wt_path.exists() {
        return Err("worktree path does not exist".into());
    }

    // Never delete the main worktree (repo root).
    let main = list_worktrees_basic(&repo_path)?
        .into_iter()
        .next()
        .map(|w| w.path);
    if main.as_deref() == Some(path.as_str()) || path == repo {
        return Err("cannot delete the main worktree".into());
    }

    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path.as_str());
    git(&repo_path, &args)?;
    Ok(())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub short_id: String,
    pub author: String,
    pub date: String,
    pub subject: String,
    pub refs: Vec<String>,
    pub parent_ids: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatusFile {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub staged: Vec<StatusFile>,
    pub unstaged: Vec<StatusFile>,
    pub has_changes: bool,
}

#[tauri::command]
fn list_commits(path: String, limit: Option<u32>) -> Result<Vec<CommitInfo>, String> {
    let repo = PathBuf::from(&path);
    let max = limit.unwrap_or(80).clamp(1, 300).to_string();
    let (code, out, stderr) = git_output(
        &repo,
        &[
            "log",
            &format!("--max-count={max}"),
            "--date=iso-strict",
            "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%P%x1f%D",
        ],
    )?;
    if code != 0 {
        if stderr.contains("does not have any commits") || stderr.contains("unknown revision") {
            return Ok(Vec::new());
        }
        return Err(if stderr.is_empty() {
            "git log failed".into()
        } else {
            stderr
        });
    }


    let mut commits = Vec::new();
    for line in out.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 7 {
            continue;
        }
        let refs = parts[6]
            .split(", ")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| {
                s.strip_prefix("HEAD -> ")
                    .or_else(|| s.strip_prefix("tag: "))
                    .unwrap_or(s)
                    .to_string()
            })
            .collect();
        let parent_ids = parts[5]
            .split_whitespace()
            .map(str::to_string)
            .collect();
        commits.push(CommitInfo {
            id: parts[0].to_string(),
            short_id: parts[1].to_string(),
            author: parts[2].to_string(),
            date: parts[3].to_string(),
            subject: parts[4].to_string(),
            refs,
            parent_ids,
        });
    }
    Ok(commits)
}

fn status_label(code: char) -> &'static str {
    match code {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'U' => "unmerged",
        '?' => "untracked",
        '!' => "ignored",
        ' ' => "clean",
        _ => "changed",
    }
}

fn parse_status_path(rest: &str) -> String {
    let rest = rest.trim();
    if let Some((orig, new_path)) = rest.split_once(" -> ") {
        let _ = orig;
        return new_path.trim().trim_matches('"').to_string();
    }
    rest.trim_matches('"').to_string()
}

#[tauri::command]
fn worktree_status(path: String) -> Result<WorktreeStatus, String> {
    let repo = PathBuf::from(&path);
    let out = git(
        &repo,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?;

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();

    for line in out.lines() {
        if line.len() < 3 {
            continue;
        }
        let mut chars = line.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        let rest = line.get(3..).unwrap_or("").trim_start();
        if rest.is_empty() {
            continue;
        }
        let file_path = parse_status_path(rest);

        if x == '?' && y == '?' {
            unstaged.push(StatusFile {
                path: file_path,
                status: status_label('?').into(),
                staged: false,
            });
            continue;
        }

        if x != ' ' && x != '?' {
            staged.push(StatusFile {
                path: file_path.clone(),
                status: status_label(x).into(),
                staged: true,
            });
        }
        if y != ' ' && y != '?' {
            unstaged.push(StatusFile {
                path: file_path,
                status: status_label(y).into(),
                staged: false,
            });
        } else if y == '?' {
            unstaged.push(StatusFile {
                path: file_path,
                status: status_label('?').into(),
                staged: false,
            });
        }
    }

    let has_changes = !staged.is_empty() || !unstaged.is_empty();
    Ok(WorktreeStatus {
        staged,
        unstaged,
        has_changes,
    })
}

#[tauri::command]
fn stage_file(path: String, file: String) -> Result<(), String> {
    let repo = PathBuf::from(&path);
    git(&repo, &["add", "--", &file])?;
    Ok(())
}

#[tauri::command]
fn unstage_file(path: String, file: String) -> Result<(), String> {
    let repo = PathBuf::from(&path);
    git(&repo, &["restore", "--staged", "--", &file])?;
    Ok(())
}

fn git_paths(repo: &Path, subcommand: &[&str], files: &[String]) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo);
    for part in subcommand {
        cmd.arg(part);
    }
    cmd.arg("--");
    for file in files {
        cmd.arg(file);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git command failed".into()
        } else {
            stderr
        });
    }
    Ok(())
}

#[tauri::command]
fn stage_files(path: String, files: Vec<String>) -> Result<(), String> {
    let repo = PathBuf::from(&path);
    git_paths(&repo, &["add"], &files)
}

#[tauri::command]
fn unstage_files(path: String, files: Vec<String>) -> Result<(), String> {
    let repo = PathBuf::from(&path);
    git_paths(&repo, &["restore", "--staged"], &files)
}

#[tauri::command]
fn commit_changes(path: String, message: String) -> Result<(), String> {
    let repo = PathBuf::from(&path);
    let message = message.trim();
    if message.is_empty() {
        return Err("commit message is empty".into());
    }

    let status = git(
        &repo,
        &["status", "--porcelain=v1", "--untracked-files=no"],
    )?;
    let has_staged = status.lines().any(|line| {
        if line.len() < 2 {
            return false;
        }
        let x = line.chars().next().unwrap_or(' ');
        x != ' ' && x != '?' && x != '!'
    });
    if !has_staged {
        return Err("nothing staged to commit".into());
    }

    git(&repo, &["commit", "-m", message])?;
    Ok(())
}



fn image_mime(path: &str) -> Option<&'static str> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

fn git_blob_bytes(repo: &Path, rev_path: &str) -> Result<Vec<u8>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["show", rev_path])
        .output()
        .map_err(|e| format!("failed to run git show: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git show failed".into()
        } else {
            stderr
        });
    }
    Ok(output.stdout)
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FilePreview {
    /// Diff as separate lines so newlines cannot be lost over IPC/UI parsing.
    Text {
        lines: Vec<String>,
    },
    Image {
        mime: String,
        base64: String,
        label: String,
    },
    Binary {
        message: String,
    },
}


fn text_diff(repo: &Path, file: &str, staged: bool) -> Result<String, String> {
    if staged {
        return git_diff(repo, &["diff", "--cached", "--", file]);
    }

    let status = git(
        repo,
        &["status", "--porcelain=v1", "--untracked-files=all", "--", file],
    )?;
    let is_untracked = status.lines().any(|l| l.starts_with("??"));
    if is_untracked {
        return git_diff(repo, &["diff", "--no-index", "--", "/dev/null", file]);
    }

    git_diff(repo, &["diff", "--", file])
}

fn load_image_bytes(repo: &Path, file: &str, staged: bool) -> Result<(Vec<u8>, String), String> {
    let worktree_path = repo.join(file);
    let status = git(
        repo,
        &["status", "--porcelain=v1", "--untracked-files=all", "--", file],
    )
    .unwrap_or_default();
    let line = status.lines().next().unwrap_or("");
    let index_status = line.chars().next().unwrap_or(' ');
    let work_status = line.chars().nth(1).unwrap_or(' ');

    if staged {
        if index_status == 'D' {
            let bytes = git_blob_bytes(repo, &format!("HEAD:{file}"))
                .or_else(|_| git_blob_bytes(repo, &format!(":{file}")))?;
            return Ok((bytes, "deleted (was)".into()));
        }
        // Staged content lives in the index (:path).
        let bytes = git_blob_bytes(repo, &format!(":{file}"))?;
        let label = if index_status == 'A' {
            "staged (new)".into()
        } else {
            "staged".into()
        };
        return Ok((bytes, label));
    }

    // Unstaged / working tree
    if work_status == 'D' || (line.len() >= 2 && &line[0..2] == " D") {
        let bytes = git_blob_bytes(repo, &format!("HEAD:{file}"))
            .or_else(|_| git_blob_bytes(repo, &format!(":{file}")))?;
        return Ok((bytes, "deleted (was)".into()));
    }

    if worktree_path.is_file() {
        let bytes = fs::read(&worktree_path).map_err(|e| format!("read image: {e}"))?;
        let label = if line.starts_with("??") {
            "untracked".into()
        } else {
            "working tree".into()
        };
        return Ok((bytes, label));
    }

    let bytes = git_blob_bytes(repo, &format!("HEAD:{file}"))?;
    Ok((bytes, "from HEAD".into()))
}

#[tauri::command]
fn file_preview(path: String, file: String, staged: bool) -> Result<FilePreview, String> {
    let repo = PathBuf::from(&path);

    if let Some(mime) = image_mime(&file) {
        match load_image_bytes(&repo, &file, staged) {
            Ok((bytes, label)) => {
                if bytes.is_empty() {
                    return Ok(FilePreview::Binary {
                        message: "Empty image file".into(),
                    });
                }
                return Ok(FilePreview::Image {
                    mime: mime.into(),
                    base64: encode_base64(&bytes),
                    label,
                });
            }
            Err(e) => {
                return Ok(FilePreview::Binary {
                    message: format!("Could not load image: {e}"),
                });
            }
        }
    }

    let text = text_diff(&repo, &file, staged)?;
    let trimmed = text.trim();
    if trimmed.starts_with("Binary files") || trimmed.contains("Binary files ") {
        return Ok(FilePreview::Binary {
            message: if trimmed.is_empty() {
                "Binary file".into()
            } else {
                trimmed.to_string()
            },
        });
    }

    let lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    Ok(FilePreview::Text { lines })
}

#[tauri::command]
fn file_diff(path: String, file: String, staged: bool) -> Result<String, String> {
    match file_preview(path, file, staged)? {
        FilePreview::Text { lines } => Ok(lines.join("\n")),
        FilePreview::Image { label, .. } => Ok(format!("[image: {label}]")),
        FilePreview::Binary { message } => Ok(message),
    }
}



fn app_data_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    Ok(dir.join(name))
}

fn projects_file(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_file(app, "projects.json")
}

fn panel_layouts_file(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_file(app, "panel-layouts.json")
}

#[tauri::command]
fn load_panel_layouts(app: AppHandle) -> Result<HashMap<String, String>, String> {
    let path = panel_layouts_file(&app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("read panel layouts: {e}"))?;
    if data.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&data).map_err(|e| format!("parse panel layouts: {e}"))
}

#[tauri::command]
fn save_panel_layouts(app: AppHandle, layouts: HashMap<String, String>) -> Result<(), String> {
    let path = panel_layouts_file(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create app data dir: {e}"))?;
    }
    let data =
        serde_json::to_string_pretty(&layouts).map_err(|e| format!("serialize layouts: {e}"))?;
    fs::write(&path, data).map_err(|e| format!("write panel layouts: {e}"))
}


#[tauri::command]
fn load_projects(app: AppHandle) -> Result<Vec<ProjectInfo>, String> {
    let path = projects_file(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let data = fs::read_to_string(&path).map_err(|e| format!("read projects: {e}"))?;
    if data.trim().is_empty() {
        return Ok(Vec::new());
    }

    serde_json::from_str(&data).map_err(|e| format!("parse projects: {e}"))
}

#[tauri::command]
fn save_projects(app: AppHandle, projects: Vec<ProjectInfo>) -> Result<(), String> {
    let path = projects_file(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create app data dir: {e}"))?;
    }

    let data =
        serde_json::to_string_pretty(&projects).map_err(|e| format!("serialize projects: {e}"))?;
    fs::write(&path, data).map_err(|e| format!("write projects: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            validate_project,
            list_worktrees,
            list_worktrees_with_status,
            remove_worktree,
            list_commits,
            worktree_status,
            stage_file,
            unstage_file,
            stage_files,
            unstage_files,
            commit_changes,
            file_preview,
            file_diff,
            load_projects,
            save_projects,
            load_panel_layouts,
            save_panel_layouts
        ])




        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_porcelain_worktrees() {
        let input = "\
worktree /tmp/repo
HEAD abcdef0123456789
branch refs/heads/main

worktree /tmp/repo-feature
HEAD fedcba9876543210
branch refs/heads/feature/foo

worktree /tmp/repo-detached
HEAD 1111111111111111
detached
";
        let list = parse_worktrees(input);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].name, "main");
        assert_eq!(list[0].path, "/tmp/repo");
        assert_eq!(list[1].name, "feature/foo");
        assert_eq!(list[2].name, "repo-detached");
        assert_eq!(list[2].branch, None);
    }

    #[test]
    fn parse_stash_branch_messages() {
        assert_eq!(
            parse_stash_branch("stash@{0}: WIP on main: abc1234 message"),
            Some("main".into())
        );
        assert_eq!(
            parse_stash_branch("stash@{1}: On feature/foo: notes"),
            Some("feature/foo".into())
        );
        assert_eq!(parse_stash_branch("stash@{2}: autostash"), None);
    }

    #[test]
    fn stash_match_by_branch() {
        let stashed = vec!["main".into(), "feature/foo".into()];
        assert!(worktree_has_stash(&Some("main".into()), &stashed));
        assert!(!worktree_has_stash(&Some("other".into()), &stashed));
        assert!(!worktree_has_stash(&None, &stashed));
    }
}




use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const DEV_NULL: &str = "NUL";
#[cfg(not(windows))]
const DEV_NULL: &str = "/dev/null";

fn same_path(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

/// Reject absolute paths and `..` so file args stay inside the worktree.
fn repo_relative_file(file: &str) -> Result<&str, String> {
    let path = Path::new(file);
    if path.as_os_str().is_empty() {
        return Err("empty file path".into());
    }
    if path.is_absolute() {
        return Err("file path must be relative to the worktree".into());
    }
    for component in path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                return Err("file path must be relative to the worktree".into());
            }
        }
    }
    Ok(file)
}

fn write_atomic(path: &Path, data: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("no parent for {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("create app data dir: {e}"))?;
    let tmp = parent.join(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("data")
    ));
    fs::write(&tmp, data).map_err(|e| format!("write temp: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename temp: {e}"))
}

fn read_json_file<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    if !path.exists() {
        return Ok(T::default());
    }
    let data = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if data.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(&data).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let data =
        serde_json::to_string_pretty(value).map_err(|e| format!("serialize: {e}"))?;
    write_atomic(path, &data)
}

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

    let toplevel = git(&repo, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    if toplevel.is_empty() {
        return Err("could not resolve repository root".into());
    }

    Ok(ProjectInfo {
        name: path_name(&toplevel),
        path: toplevel,
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
    let main_path = list_worktrees_basic(&repo_path)?
        .into_iter()
        .next()
        .map(|w| PathBuf::from(w.path));
    if main_path
        .as_ref()
        .is_some_and(|main| same_path(main, &wt_path))
        || same_path(&repo_path, &wt_path)
    {
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
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileInfo {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub message: String,
    pub parents: Vec<String>,
    pub files: Vec<CommitFileInfo>,
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
            "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%D",
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

    Ok(parse_commit_log(&out))
}

fn parse_commit_log(out: &str) -> Vec<CommitInfo> {
    let mut commits = Vec::new();
    for line in out.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 6 {
            continue;
        }
        let refs = parts[5]
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
        commits.push(CommitInfo {
            id: parts[0].to_string(),
            short_id: parts[1].to_string(),
            author: parts[2].to_string(),
            date: parts[3].to_string(),
            subject: parts[4].to_string(),
            refs,
        });
    }
    commits
}

fn parse_commit_files(out: &str) -> Vec<CommitFileInfo> {
    out.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() < 2 {
                return None;
            }
            let status = fields[0].chars().next().unwrap_or('?');
            let path = fields.last()?.trim();
            if path.is_empty() {
                return None;
            }
            Some(CommitFileInfo {
                path: parse_status_path(path),
                status: status_label(status).into(),
            })
        })
        .collect()
}

fn valid_commit_id(commit: &str) -> Result<String, String> {
    let id = commit.trim();
    if (id.len() != 40 && id.len() != 64) || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid commit hash".into());
    }
    Ok(id.to_string())
}

fn first_parent(repo: &Path, commit: &str) -> Result<Option<String>, String> {
    Ok(git(repo, &["show", "-s", "--format=%P", commit])?
        .split_whitespace()
        .next()
        .map(str::to_string))
}

#[tauri::command]
fn commit_details(path: String, commit: String) -> Result<CommitDetails, String> {
    let repo = PathBuf::from(&path);
    let commit = valid_commit_id(&commit)?;
    let metadata = git(
        &repo,
        &[
            "show",
            "-s",
            "--date=iso-strict",
            "--format=%H%x1f%P%x1f%an%x1f%ad%x1f%B",
            &commit,
        ],
    )?;
    let parts: Vec<&str> = metadata.splitn(5, '\x1f').collect();
    if parts.len() < 5 {
        return Err("could not read commit details".into());
    }

    let parents: Vec<String> = parts[1].split_whitespace().map(str::to_string).collect();
    let files = match parents.first() {
        Some(parent) => git(
            &repo,
            &["diff", "--find-renames", "--name-status", parent, &commit],
        )?,
        None => git(
            &repo,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-status",
                "-r",
                "--find-renames",
                &commit,
            ],
        )?,
    };

    Ok(CommitDetails {
        message: parts[4].trim().to_string(),
        parents,
        files: parse_commit_files(&files),
    })
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
    if let Some((_orig, new_path)) = rest.split_once(" -> ") {
        return new_path.trim().trim_matches('"').to_string();
    }
    rest.trim_matches('"').to_string()
}

fn parse_status_porcelain(out: &str) -> WorktreeStatus {
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
    WorktreeStatus {
        staged,
        unstaged,
        has_changes,
    }
}

#[tauri::command]
fn worktree_status(path: String) -> Result<WorktreeStatus, String> {
    let repo = PathBuf::from(&path);
    let out = git(
        &repo,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?;
    Ok(parse_status_porcelain(&out))
}

fn git_paths(repo: &Path, subcommand: &[&str], files: &[String]) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    for file in files {
        repo_relative_file(file)?;
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
fn stage_file(path: String, file: String) -> Result<(), String> {
    git_paths(&PathBuf::from(path), &["add"], &[file])
}

#[tauri::command]
fn unstage_file(path: String, file: String) -> Result<(), String> {
    git_paths(&PathBuf::from(path), &["restore", "--staged"], &[file])
}

#[tauri::command]
fn stage_files(path: String, files: Vec<String>) -> Result<(), String> {
    git_paths(&PathBuf::from(path), &["add"], &files)
}

#[tauri::command]
fn unstage_files(path: String, files: Vec<String>) -> Result<(), String> {
    git_paths(&PathBuf::from(path), &["restore", "--staged"], &files)
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

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub has_remote_branch: bool,
    pub can_push: bool,
    pub can_pull: bool,
}

fn current_branch(repo: &Path) -> Result<Option<String>, String> {
    let name = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    if name.is_empty() || name == "HEAD" {
        return Ok(None);
    }
    Ok(Some(name))
}

fn has_origin(repo: &Path) -> bool {
    git(repo, &["remote", "get-url", "origin"]).is_ok()
}

fn remote_branch_exists(repo: &Path, branch: &str) -> bool {
    let reference = format!("refs/remotes/origin/{branch}");
    git_output(repo, &["show-ref", "--verify", "--quiet", &reference])
        .map(|(code, _, _)| code == 0)
        .unwrap_or(false)
}

fn parse_ahead_behind(output: &str) -> (u32, u32) {
    let mut parts = output.split_whitespace();
    let ahead = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    let behind = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    (ahead, behind)
}

fn branch_creation_commit(repo: &Path, branch: &str) -> Option<String> {
    let reflog = git(repo, &["reflog", "show", "--format=%H%x1f%gs", branch]).ok()?;
    reflog.lines().rev().find_map(|line| {
        let (commit, subject) = line.split_once('\x1f')?;
        subject
            .starts_with("branch: Created from ")
            .then(|| commit.to_string())
    })
}

#[tauri::command]
fn remote_sync_status(path: String) -> Result<SyncStatus, String> {
    let repo = PathBuf::from(&path);
    let branch = current_branch(&repo)?;

    let Some(branch) = branch else {
        return Ok(SyncStatus {
            branch: None,
            ahead: 0,
            behind: 0,
            has_remote_branch: false,
            can_push: false,
            can_pull: false,
        });
    };

    if !has_origin(&repo) {
        return Ok(SyncStatus {
            branch: Some(branch),
            ahead: 0,
            behind: 0,
            has_remote_branch: false,
            can_push: false,
            can_pull: false,
        });
    }

    if !remote_branch_exists(&repo, &branch) {
        let ahead = branch_creation_commit(&repo, &branch)
            .and_then(|base| {
                let range = format!("{base}..HEAD");
                git(&repo, &["rev-list", "--count", &range])
                    .ok()
                    .and_then(|s| s.trim().parse().ok())
            })
            .unwrap_or(0);
        return Ok(SyncStatus {
            branch: Some(branch),
            ahead,
            behind: 0,
            has_remote_branch: false,
            can_push: true,
            can_pull: false,
        });
    }

    let remote = format!("origin/{branch}");
    let range = format!("HEAD...{remote}");
    let counts = git(
        &repo,
        &["rev-list", "--left-right", "--count", &range],
    )?;
    let (ahead, behind) = parse_ahead_behind(counts.trim());

    Ok(SyncStatus {
        branch: Some(branch),
        ahead,
        behind,
        has_remote_branch: true,
        can_push: ahead > 0,
        can_pull: behind > 0,
    })
}

#[tauri::command]
fn push_origin(path: String) -> Result<(), String> {
    let repo = PathBuf::from(&path);
    if !has_origin(&repo) {
        return Err("remote origin not configured".into());
    }
    let branch = current_branch(&repo)?.ok_or_else(|| "detached HEAD".to_string())?;

    if remote_branch_exists(&repo, &branch) {
        git(&repo, &["push", "origin", "HEAD"])?;
    } else {
        git(&repo, &["push", "-u", "origin", "HEAD"])?;
    }
    Ok(())
}

#[tauri::command]
fn pull_origin(path: String) -> Result<(), String> {
    let repo = PathBuf::from(&path);
    if !has_origin(&repo) {
        return Err("remote origin not configured".into());
    }
    let branch = current_branch(&repo)?.ok_or_else(|| "detached HEAD".to_string())?;
    git(&repo, &["pull", "--ff-only", "origin", &branch])?;
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

fn commit_text_diff(repo: &Path, file: &str, commit: &str) -> Result<String, String> {
    if let Some(parent) = first_parent(repo, commit)? {
        return git_diff(repo, &["diff", "--find-renames", &parent, commit, "--", file]);
    }
    git_diff(
        repo,
        &[
            "diff-tree",
            "--root",
            "--no-commit-id",
            "-p",
            "--find-renames",
            commit,
            "--",
            file,
        ],
    )
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
        return git_diff(repo, &["diff", "--no-index", "--", DEV_NULL, file]);
    }

    git_diff(repo, &["diff", "--", file])
}

fn is_binary_diff(text: &str) -> bool {
    text.lines().any(|line| line.starts_with("Binary files "))
}

fn load_committed_image_bytes(
    repo: &Path,
    file: &str,
    commit: &str,
) -> Result<(Vec<u8>, String), String> {
    let rev_path = format!("{commit}:{file}");
    match git_blob_bytes(repo, &rev_path) {
        Ok(bytes) => Ok((bytes, "committed".into())),
        Err(error) => {
            let path_exists = match git(
                repo,
                &["ls-tree", "-r", "--name-only", commit, "--", file],
            ) {
                Ok(paths) => !paths.trim().is_empty(),
                Err(_) => return Err(error),
            };
            if path_exists {
                return Err(error);
            }

            let parent_ref = format!("{commit}^");
            let parent = git(repo, &["rev-parse", &parent_ref])?;
            let parent_path = format!("{}:{file}", parent.trim());
            let bytes = git_blob_bytes(repo, &parent_path)?;
            Ok((bytes, "deleted (was)".into()))
        }
    }
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
    repo_relative_file(&file)?;
    let repo = PathBuf::from(&path);

    file_preview_for(&repo, &file, staged, None)
}

#[tauri::command]
fn commit_file_preview(path: String, file: String, commit: String) -> Result<FilePreview, String> {
    repo_relative_file(&file)?;
    let repo = PathBuf::from(&path);
    let commit = valid_commit_id(&commit)?;

    file_preview_for(&repo, &file, false, Some(&commit))
}

fn file_preview_for(
    repo: &Path,
    file: &str,
    staged: bool,
    commit: Option<&str>,
) -> Result<FilePreview, String> {
    if let Some(mime) = image_mime(file) {
        let image = match commit {
            Some(commit) => load_committed_image_bytes(repo, file, commit),
            None => load_image_bytes(repo, file, staged),
        };
        match image {
            Ok((bytes, label)) => {
                if bytes.is_empty() {
                    return Ok(FilePreview::Binary {
                        message: "Empty image file".into(),
                    });
                }
                // Cap IPC payload size for large images.
                const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
                if bytes.len() > MAX_IMAGE_BYTES {
                    return Ok(FilePreview::Binary {
                        message: format!(
                            "Image too large to preview ({} bytes)",
                            bytes.len()
                        ),
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

    let text = match commit {
        Some(commit) => commit_text_diff(repo, file, commit)?,
        None => text_diff(repo, file, staged)?,
    };
    let trimmed = text.trim();
    if is_binary_diff(&text) {
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

fn app_data_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    Ok(dir.join(name))
}

#[tauri::command]
fn load_panel_layouts(app: AppHandle) -> Result<HashMap<String, String>, String> {
    read_json_file(&app_data_file(&app, "panel-layouts.json")?)
}

#[tauri::command]
fn save_panel_layouts(app: AppHandle, layouts: HashMap<String, String>) -> Result<(), String> {
    write_json_file(&app_data_file(&app, "panel-layouts.json")?, &layouts)
}

#[tauri::command]
fn load_projects(app: AppHandle) -> Result<Vec<ProjectInfo>, String> {
    read_json_file(&app_data_file(&app, "projects.json")?)
}

#[tauri::command]
fn save_projects(app: AppHandle, projects: Vec<ProjectInfo>) -> Result<(), String> {
    write_json_file(&app_data_file(&app, "projects.json")?, &projects)
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
            commit_details,
            worktree_status,
            stage_file,
            unstage_file,
            stage_files,
            unstage_files,
            commit_changes,
            remote_sync_status,
            push_origin,
            pull_origin,
            file_preview,
            commit_file_preview,
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("canopy-test-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

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
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[0].head.as_deref(), Some("abcdef0123456789"));
        assert_eq!(list[1].name, "feature/foo");
        assert_eq!(list[2].name, "repo-detached");
        assert_eq!(list[2].branch, None);
        assert!(!list[0].has_changes);
        assert!(!list[0].has_stash);
    }

    #[test]
    fn parse_porcelain_worktrees_empty() {
        assert!(parse_worktrees("").is_empty());
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
        assert_eq!(parse_stash_branch("not a stash line"), None);
    }

    #[test]
    fn stash_match_by_branch() {
        let stashed = vec!["main".into(), "feature/foo".into()];
        assert!(worktree_has_stash(&Some("main".into()), &stashed));
        assert!(!worktree_has_stash(&Some("other".into()), &stashed));
        assert!(!worktree_has_stash(&None, &stashed));
    }

    #[test]
    fn parse_ahead_behind_counts() {
        assert_eq!(parse_ahead_behind("2\t1\n"), (2, 1));
        assert_eq!(parse_ahead_behind("0 3"), (0, 3));
        assert_eq!(parse_ahead_behind(""), (0, 0));
        assert_eq!(parse_ahead_behind("nope"), (0, 0));
    }

    #[test]
    fn branch_creation_commit_reads_created_from_reflog() {
        let dir = temp_dir("branch-creation");
        git(&dir, &["init", "-q"]).unwrap();
        git(&dir, &["config", "user.email", "test@example.com"]).unwrap();
        git(&dir, &["config", "user.name", "Test"]).unwrap();
        git(&dir, &["commit", "--allow-empty", "-qm", "base"]).unwrap();
        let base = git(&dir, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        git(&dir, &["switch", "-c", "feature"]).unwrap();

        assert_eq!(branch_creation_commit(&dir, "feature"), Some(base));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn repo_relative_file_accepts_and_rejects() {
        assert_eq!(repo_relative_file("src/main.rs").unwrap(), "src/main.rs");
        assert_eq!(repo_relative_file("./foo").unwrap(), "./foo");
        assert_eq!(repo_relative_file("a/b/c.txt").unwrap(), "a/b/c.txt");
        assert!(repo_relative_file("../secret").is_err());
        assert!(repo_relative_file("a/../b").is_err());
        assert!(repo_relative_file("/etc/passwd").is_err());
        assert!(repo_relative_file("").is_err());
    }

    #[test]
    fn short_branch_strips_refs_heads() {
        assert_eq!(short_branch("refs/heads/main"), "main");
        assert_eq!(short_branch("refs/heads/feature/x"), "feature/x");
        assert_eq!(short_branch("main"), "main");
    }

    #[test]
    fn path_name_uses_last_segment() {
        assert_eq!(path_name("/tmp/repo-feature"), "repo-feature");
        assert_eq!(path_name("simple"), "simple");
    }

    #[test]
    fn status_label_maps_codes() {
        assert_eq!(status_label('M'), "modified");
        assert_eq!(status_label('A'), "added");
        assert_eq!(status_label('D'), "deleted");
        assert_eq!(status_label('R'), "renamed");
        assert_eq!(status_label('?'), "untracked");
        assert_eq!(status_label('X'), "changed");
    }

    #[test]
    fn parse_status_path_handles_rename_and_quotes() {
        assert_eq!(parse_status_path("src/a.rs"), "src/a.rs");
        assert_eq!(parse_status_path("\"path with space.rs\""), "path with space.rs");
        assert_eq!(
            parse_status_path("old.rs -> new.rs"),
            "new.rs"
        );
        assert_eq!(
            parse_status_path("\"old name.rs\" -> \"new name.rs\""),
            "new name.rs"
        );
    }

    #[test]
    fn parse_status_porcelain_splits_staged_unstaged() {
        let out = "\
M  staged.rs
 M unstaged.rs
MM both.rs
A  added.rs
?? untracked.rs
R  old.rs -> renamed.rs
";
        let status = parse_status_porcelain(out);
        assert!(status.has_changes);

        let staged_paths: Vec<_> = status.staged.iter().map(|f| f.path.as_str()).collect();
        assert!(staged_paths.contains(&"staged.rs"));
        assert!(staged_paths.contains(&"both.rs"));
        assert!(staged_paths.contains(&"added.rs"));
        assert!(staged_paths.contains(&"renamed.rs"));
        assert!(!staged_paths.contains(&"unstaged.rs"));
        assert!(!staged_paths.contains(&"untracked.rs"));

        let unstaged_paths: Vec<_> = status.unstaged.iter().map(|f| f.path.as_str()).collect();
        assert!(unstaged_paths.contains(&"unstaged.rs"));
        assert!(unstaged_paths.contains(&"both.rs"));
        assert!(unstaged_paths.contains(&"untracked.rs"));

        let untracked = status
            .unstaged
            .iter()
            .find(|f| f.path == "untracked.rs")
            .unwrap();
        assert_eq!(untracked.status, "untracked");
        assert!(!untracked.staged);
    }

    #[test]
    fn parse_status_porcelain_empty() {
        let status = parse_status_porcelain("");
        assert!(!status.has_changes);
        assert!(status.staged.is_empty());
        assert!(status.unstaged.is_empty());
    }

    #[test]
    fn parse_commit_log_fields_and_refs() {
        let out = format!(
            "{}\x1f{}\x1f{}\x1f{}\x1f{}\x1f{}",
            "aabbccddeeff00112233445566778899aabbccdd",
            "aabbccd",
            "Ada",
            "2026-01-02T03:04:05+00:00",
            "Ship it",
            "HEAD -> main, origin/main, tag: v1.0"
        );
        let commits = parse_commit_log(&out);
        assert_eq!(commits.len(), 1);
        let c = &commits[0];
        assert_eq!(c.short_id, "aabbccd");
        assert_eq!(c.author, "Ada");
        assert_eq!(c.subject, "Ship it");
        assert_eq!(c.refs, vec!["main", "origin/main", "v1.0"]);
    }

    #[test]
    fn parse_commit_log_skips_short_lines() {
        assert!(parse_commit_log("too\x1fshort").is_empty());
        assert!(parse_commit_log("").is_empty());
    }

    #[test]
    fn parse_commit_files_maps_status_and_rename_paths() {
        let files = parse_commit_files("M\tchanged.rs\nA\tnew.rs\nR100\told.rs\tnew-name.rs\n");
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "changed.rs");
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[1].status, "added");
        assert_eq!(files[2].path, "new-name.rs");
        assert_eq!(files[2].status, "renamed");
    }

    #[test]
    fn valid_commit_id_accepts_hash_lengths_only() {
        assert!(valid_commit_id(&"a".repeat(40)).is_ok());
        assert!(valid_commit_id(&"a".repeat(64)).is_ok());
        assert!(valid_commit_id("not-a-commit").is_err());
        assert!(valid_commit_id(&"a".repeat(39)).is_err());
    }

    #[test]
    fn image_mime_by_extension() {
        assert_eq!(image_mime("a.PNG"), Some("image/png"));
        assert_eq!(image_mime("x/y.jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime("icon.svg"), Some("image/svg+xml"));
        assert_eq!(image_mime("readme.md"), None);
        assert_eq!(image_mime("noext"), None);
    }

    #[test]
    fn committed_image_label_matches_source_commit() {
        let dir = temp_dir("committed-image-label");
        git(&dir, &["init", "-q"]).unwrap();
        git(&dir, &["config", "user.email", "test@example.com"]).unwrap();
        git(&dir, &["config", "user.name", "Test"]).unwrap();

        let image = dir.join("deleted.png");
        fs::write(&image, b"old").unwrap();
        git(&dir, &["add", "deleted.png"]).unwrap();
        git(&dir, &["commit", "-qm", "add image"]).unwrap();
        let source_commit = git(&dir, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();

        fs::remove_file(&image).unwrap();
        git(&dir, &["add", "-u"]).unwrap();
        git(&dir, &["commit", "-qm", "delete image"]).unwrap();
        let deleted_commit = git(&dir, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();

        let (bytes, label) =
            load_committed_image_bytes(&dir, "deleted.png", &source_commit).unwrap();
        assert_eq!(bytes, b"old");
        assert_eq!(label, "committed");

        let (bytes, label) =
            load_committed_image_bytes(&dir, "deleted.png", &deleted_commit).unwrap();
        assert_eq!(bytes, b"old");
        assert_eq!(label, "deleted (was)");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn binary_diff_detection_ignores_source_text() {
        assert!(!is_binary_diff(
            "diff --git a/lib.rs b/lib.rs\n+if text.contains(\"Binary files \") {}\n"
        ));
        assert!(is_binary_diff("Binary files a/image.png and b/image.png differ\n"));
    }

    #[test]
    fn encode_base64_padding() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn write_atomic_roundtrip() {
        let dir = temp_dir("atomic");
        let path = dir.join("data.json");
        write_atomic(&path, "{\"ok\":true}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"ok\":true}");
        // overwrite
        write_atomic(&path, "{\"ok\":false}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"ok\":false}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_write_json_file_roundtrip() {
        let dir = temp_dir("json");
        let path = dir.join("projects.json");

        let missing: Vec<ProjectInfo> = read_json_file(&path).unwrap();
        assert!(missing.is_empty());

        let projects = vec![ProjectInfo {
            path: "/tmp/repo".into(),
            name: "repo".into(),
            worktrees: vec!["/tmp/wt".into()],
        }];
        write_json_file(&path, &projects).unwrap();

        let loaded: Vec<ProjectInfo> = read_json_file(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "repo");
        assert_eq!(loaded[0].worktrees, vec!["/tmp/wt".to_string()]);

        // empty file → default
        fs::write(&path, "   ").unwrap();
        let empty: Vec<ProjectInfo> = read_json_file(&path).unwrap();
        assert!(empty.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn same_path_matches_identical_and_canonical() {
        let dir = temp_dir("same-path");
        let a = dir.join("file.txt");
        fs::write(&a, "x").unwrap();
        assert!(same_path(&a, &a));
        assert!(same_path(&dir, &dir));
        assert!(!same_path(&a, &dir.join("missing.txt")));
        let _ = fs::remove_dir_all(&dir);
    }
}

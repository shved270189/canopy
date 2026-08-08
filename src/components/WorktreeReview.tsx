import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type PanelGroupStorage,
} from "react-resizable-panels";
import { ArrowDownToLine, ArrowUpFromLine, GitCommitHorizontal } from "lucide-react";
import type {
  Commit,
  FilePreview,
  SelectedFile,
  StatusFile,
  SyncStatus,
  WorktreeStatus,
} from "../types";

import { CommitGraph } from "./CommitGraph";
import { DiffView } from "./DiffView";
import { StatusFileSection } from "./StatusFiles";

const REFRESH_MS = 10000;

const EMPTY_SYNC: SyncStatus = {
  branch: null,
  ahead: 0,
  behind: 0,
  canPush: false,
  canPull: false,
};

type WorktreeReviewProps = {
  worktreePath: string;
  panelStorage: PanelGroupStorage;
};

export function WorktreeReview({ worktreePath, panelStorage }: WorktreeReviewProps) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [status, setStatus] = useState<WorktreeStatus>({
    staged: [],
    unstaged: [],
    hasChanges: false,
  });
  const [sync, setSync] = useState<SyncStatus>(EMPTY_SYNC);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [loadingGraph, setLoadingGraph] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [busyStage, setBusyStage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pullBusy, setPullBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshSync = useCallback(async () => {
    try {
      const next = await invoke<SyncStatus>("remote_sync_status", {
        path: worktreePath,
      });
      setSync((prev) =>
        prev.branch === next.branch &&
        prev.ahead === next.ahead &&
        prev.behind === next.behind &&
        prev.canPush === next.canPush &&
        prev.canPull === next.canPull
          ? prev
          : next,
      );
    } catch {
      setSync((prev) =>
        prev === EMPTY_SYNC ||
        (!prev.branch &&
          prev.ahead === 0 &&
          prev.behind === 0 &&
          !prev.canPush &&
          !prev.canPull)
          ? prev
          : EMPTY_SYNC,
      );
    }
  }, [worktreePath]);

  const refreshStatus = useCallback(
    async (options?: { silent?: boolean }): Promise<WorktreeStatus | null> => {
      const silent = options?.silent ?? false;
      if (!silent) setLoadingStatus(true);
      try {
        const next = await invoke<WorktreeStatus>("worktree_status", {
          path: worktreePath,
        });
        setStatus((prev) => {
          if (
            prev.hasChanges === next.hasChanges &&
            prev.staged.length === next.staged.length &&
            prev.unstaged.length === next.unstaged.length &&
            prev.staged.every(
              (f, i) =>
                f.path === next.staged[i]?.path &&
                f.status === next.staged[i]?.status &&
                f.staged === next.staged[i]?.staged,
            ) &&
            prev.unstaged.every(
              (f, i) =>
                f.path === next.unstaged[i]?.path &&
                f.status === next.unstaged[i]?.status &&
                f.staged === next.unstaged[i]?.staged,
            )
          ) {
            return prev;
          }
          return next;
        });
        if (!silent) setError(null);
        return next;
      } catch (e) {
        if (!silent) setError(String(e));
        return null;
      } finally {
        if (!silent) setLoadingStatus(false);
      }
    },
    [worktreePath],
  );

  const refreshCommits = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      if (!silent) setLoadingGraph(true);
      try {
        const list = await invoke<Commit[]>("list_commits", {
          path: worktreePath,
          limit: 80,
        });
        setCommits((prev) => {
          if (
            prev.length === list.length &&
            prev.every(
              (c, i) =>
                c.id === list[i]?.id &&
                c.subject === list[i]?.subject &&
                c.shortId === list[i]?.shortId &&
                c.author === list[i]?.author &&
                c.date === list[i]?.date &&
                c.refs.length === list[i]?.refs.length &&
                c.refs.every((r, j) => r === list[i]?.refs[j]),
            )
          ) {
            return prev;
          }
          return list;
        });
      } catch (e) {
        if (!silent) setError(String(e));
      } finally {
        if (!silent) setLoadingGraph(false);
      }
    },
    [worktreePath],
  );

  const loadDiff = useCallback(
    async (file: SelectedFile) => {
      setLoadingDiff(true);
      setDiffError(null);
      try {
        const next = await invoke<FilePreview>("file_preview", {
          path: worktreePath,
          file: file.path,
          staged: file.staged,
        });
        setPreview(next);
      } catch (e) {
        setPreview(null);
        setDiffError(String(e));
      } finally {
        setLoadingDiff(false);
      }
    },
    [worktreePath],
  );

  useEffect(() => {
    setSelectedFile(null);
    setPreview(null);
    setDiffError(null);
    setCommitOpen(false);
    setCommitMessage("");
    setCommitError(null);
    setActionError(null);
    setSync(EMPTY_SYNC);
    void refreshCommits();
    void refreshStatus();
    void refreshSync();
  }, [worktreePath, refreshCommits, refreshStatus, refreshSync]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshStatus({ silent: true });
      void refreshCommits({ silent: true });
      void refreshSync();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refreshStatus, refreshCommits, refreshSync]);

  useEffect(() => {
    if (!selectedFile) {
      setPreview(null);
      return;
    }
    void loadDiff(selectedFile);
  }, [selectedFile, loadDiff]);

  async function handleToggleStage(file: StatusFile) {
    setBusyStage(true);
    setError(null);

    const wasStaged = file.staged;
    const sourceList = wasStaged ? status.staged : status.unstaged;
    const sourceIndex = sourceList.findIndex((f) => f.path === file.path);

    try {
      if (wasStaged) {
        await invoke("unstage_file", { path: worktreePath, file: file.path });
      } else {
        await invoke("stage_file", { path: worktreePath, file: file.path });
      }

      const next = await refreshStatus({ silent: true });
      if (!next) return;

      if (wasStaged) {
        if (next.staged.length > 0) {
          const idx =
            sourceIndex < 0
              ? 0
              : Math.min(sourceIndex, next.staged.length - 1);
          const pick = next.staged[idx];
          setSelectedFile({ path: pick.path, staged: true });
        } else if (next.unstaged.length > 0) {
          setSelectedFile({ path: next.unstaged[0].path, staged: false });
        } else {
          setSelectedFile(null);
        }
      } else if (next.unstaged.length > 0) {
        const idx =
          sourceIndex < 0
            ? 0
            : Math.min(sourceIndex, next.unstaged.length - 1);
        const pick = next.unstaged[idx];
        setSelectedFile({ path: pick.path, staged: false });
      } else if (next.staged.length > 0) {
        setSelectedFile({ path: next.staged[0].path, staged: true });
      } else {
        setSelectedFile(null);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyStage(false);
    }
  }

  function openCommitPanel() {
    if (commitOpen) {
      handleCommitCancel();
      return;
    }
    setCommitOpen(true);
    setCommitError(null);
    setActionError(null);
  }

  async function handleCommit() {
    const message = commitMessage.trim();
    if (!message) {
      setCommitError("Enter a commit message");
      return;
    }

    setCommitBusy(true);
    setCommitError(null);
    try {
      await invoke("commit_changes", {
        path: worktreePath,
        message,
      });
      setCommitOpen(false);
      setCommitMessage("");
      setSelectedFile(null);
      setPreview(null);
      await refreshStatus({ silent: true });
      await refreshCommits({ silent: true });
      await refreshSync();
    } catch (e) {
      setCommitError(String(e));
    } finally {
      setCommitBusy(false);
    }
  }

  function handleCommitCancel() {
    setCommitOpen(false);
    setCommitMessage("");
    setCommitError(null);
  }

  async function handlePush() {
    setPushBusy(true);
    setActionError(null);
    try {
      await invoke("push_origin", { path: worktreePath });
      await refreshSync();
      await refreshCommits({ silent: true });
    } catch (e) {
      setActionError(String(e));
    } finally {
      setPushBusy(false);
    }
  }

  async function handlePull() {
    setPullBusy(true);
    setActionError(null);
    try {
      await invoke("pull_origin", { path: worktreePath });
      await refreshSync();
      await refreshCommits({ silent: true });
      await refreshStatus({ silent: true });
    } catch (e) {
      setActionError(String(e));
    } finally {
      setPullBusy(false);
    }
  }

  async function handleToggleAll(staged: boolean) {
    const files = staged ? status.staged : status.unstaged;
    if (files.length === 0) return;

    setBusyStage(true);
    setError(null);
    try {
      const paths = files.map((f) => f.path);
      if (staged) {
        await invoke("unstage_files", { path: worktreePath, files: paths });
      } else {
        await invoke("stage_files", { path: worktreePath, files: paths });
      }

      const next = await refreshStatus({ silent: true });
      if (!next) return;

      if (staged) {
        if (next.unstaged.length > 0) {
          setSelectedFile({ path: next.unstaged[0].path, staged: false });
        } else if (next.staged.length > 0) {
          setSelectedFile({ path: next.staged[0].path, staged: true });
        } else {
          setSelectedFile(null);
        }
      } else if (next.staged.length > 0) {
        setSelectedFile({ path: next.staged[0].path, staged: true });
      } else if (next.unstaged.length > 0) {
        setSelectedFile({ path: next.unstaged[0].path, staged: false });
      } else {
        setSelectedFile(null);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyStage(false);
    }
  }

  const canCommit = status.staged.length > 0;
  const actionBusy = commitBusy || pushBusy || pullBusy || busyStage;
  const canPush = sync.canPush && !actionBusy;
  const canPull = sync.canPull && !actionBusy;

  return (
    <div className="worktree-review">
      <div className="git-actions-bar">
        <button
          type="button"
          className={`git-action-btn${commitOpen ? " active" : ""}`}
          onClick={openCommitPanel}
          disabled={!canCommit || actionBusy}
        >
          <GitCommitHorizontal size={15} strokeWidth={1.75} aria-hidden />
          <span>Commit{canCommit ? ` (${status.staged.length})` : ""}</span>
        </button>
        <button
          type="button"
          className="git-action-btn"
          onClick={() => void handlePush()}
          disabled={!canPush}
        >
          <ArrowUpFromLine size={15} strokeWidth={1.75} aria-hidden />
          <span>
            {pushBusy
              ? "Pushing…"
              : sync.ahead > 0
                ? `Push (${sync.ahead})`
                : "Push"}
          </span>
        </button>
        <button
          type="button"
          className="git-action-btn"
          onClick={() => void handlePull()}
          disabled={!canPull}
        >
          <ArrowDownToLine size={15} strokeWidth={1.75} aria-hidden />
          <span>
            {pullBusy
              ? "Pulling…"
              : sync.behind > 0
                ? `Pull (${sync.behind})`
                : "Pull"}
          </span>
        </button>
      </div>

      <header className="main-topbar" title={worktreePath}>
        <span className="main-path">{worktreePath}</span>
      </header>

      {commitOpen && (
        <div className="commit-panel" role="dialog" aria-label="Commit changes">
          <label className="commit-label" htmlFor="commit-message">
            Commit message
          </label>
          <textarea
            id="commit-message"
            className="commit-textarea"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Describe your changes…"
            rows={3}
            autoFocus
            disabled={commitBusy}
          />
          {commitError && <p className="commit-error">{commitError}</p>}
          <div className="commit-actions">
            <button
              type="button"
              className="commit-btn secondary"
              onClick={handleCommitCancel}
              disabled={commitBusy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="commit-btn primary"
              onClick={() => void handleCommit()}
              disabled={commitBusy || !commitMessage.trim()}
            >
              {commitBusy ? "Committing…" : "Commit"}
            </button>
          </div>
        </div>
      )}

      {(error || actionError) && (
        <p className="review-error">{error || actionError}</p>
      )}

      <PanelGroup
        direction="vertical"
        autoSaveId="canopy-worktree-vertical"
        storage={panelStorage}
        className="review-panels"
      >
        <Panel defaultSize={33.33} minSize={15}>
          <div className="panel-fill">
            <CommitGraph
              commits={commits}
              hasChanges={status.hasChanges}
              loading={loadingGraph || loadingStatus}
            />
          </div>
        </Panel>

        <PanelResizeHandle className="resize-handle horizontal" />

        <Panel defaultSize={66.67} minSize={25}>
          <div className="panel-fill">
            <PanelGroup
              direction="horizontal"
              autoSaveId="canopy-worktree-bottom"
              storage={panelStorage}
              className="review-panels"
            >
              <Panel defaultSize={50} minSize={20}>
                <div className="panel-fill">
                  <PanelGroup
                    direction="vertical"
                    autoSaveId="canopy-worktree-files"
                    storage={panelStorage}
                    className="review-panels files-pane"
                  >
                    <Panel defaultSize={50} minSize={15}>
                      <div className="panel-fill">
                        <StatusFileSection
                          title="Staged files"
                          files={status.staged}
                          staged
                          selected={selectedFile}
                          busy={busyStage}
                          emptyLabel="No staged files"
                          onToggleStage={handleToggleStage}
                          onToggleAll={() => void handleToggleAll(true)}
                          onSelectFile={setSelectedFile}
                        />
                      </div>
                    </Panel>

                    <PanelResizeHandle className="resize-handle horizontal" />

                    <Panel defaultSize={50} minSize={15}>
                      <div className="panel-fill">
                        <StatusFileSection
                          title="Unstaged files"
                          files={status.unstaged}
                          staged={false}
                          selected={selectedFile}
                          busy={busyStage}
                          emptyLabel="No unstaged files"
                          onToggleStage={handleToggleStage}
                          onToggleAll={() => void handleToggleAll(false)}
                          onSelectFile={setSelectedFile}
                        />
                      </div>
                    </Panel>
                  </PanelGroup>
                </div>
              </Panel>

              <PanelResizeHandle className="resize-handle vertical" />

              <Panel defaultSize={50} minSize={20}>
                <div className="panel-fill">
                  <DiffView
                    file={selectedFile}
                    preview={preview}
                    loading={loadingDiff}
                    error={diffError}
                  />
                </div>
              </Panel>
            </PanelGroup>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}

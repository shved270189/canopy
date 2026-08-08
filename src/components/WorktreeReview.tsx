import { useCallback, useEffect, useRef, useState } from "react";
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
  CommitDetails,
  FilePreview,
  GraphSelection,
  SelectedFile,
  StatusFile,
  SyncStatus,
  WorktreeStatus,
} from "../types";

import { CommitGraph, formatDate } from "./CommitGraph";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { DiffView } from "./DiffView";
import { CommitFileSection, StatusFileSection } from "./StatusFiles";

const REFRESH_MS = 10000;

const EMPTY_STATUS: WorktreeStatus = {
  staged: [],
  unstaged: [],
  hasChanges: false,
};

const EMPTY_SYNC: SyncStatus = {
  branch: null,
  ahead: 0,
  behind: 0,
  hasRemoteBranch: false,
  canPush: false,
  canPull: false,
};

type WorktreeReviewProps = {
  worktreePath: string;
  panelStorage: PanelGroupStorage;
};

type FileMenuState = {
  x: number;
  y: number;
  path: string;
};

function fullFilePath(worktreePath: string, filePath: string): string {
  const separator = worktreePath.includes("\\") ? "\\" : "/";
  const relativeFilePath = filePath
    .replace(/^[/\\]+/, "")
    .replace(/[\\/]+/g, separator);
  return `${worktreePath.replace(/[\\/]+$/, "")}${separator}${relativeFilePath}`;
}

async function copyPath(path: string): Promise<void> {
  if (!navigator.clipboard) return;
  try {
    await navigator.clipboard.writeText(path);
  } catch {}
}

function statusEqual(a: WorktreeStatus, b: WorktreeStatus): boolean {
  if (a.hasChanges !== b.hasChanges) return false;
  if (a.staged.length !== b.staged.length || a.unstaged.length !== b.unstaged.length) {
    return false;
  }
  const same = (x: StatusFile, y: StatusFile) =>
    x.path === y.path && x.status === y.status && x.staged === y.staged;
  return (
    a.staged.every((f, i) => same(f, b.staged[i])) &&
    a.unstaged.every((f, i) => same(f, b.unstaged[i]))
  );
}

function commitsEqual(a: Commit[], b: Commit[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (c, i) =>
      c.id === b[i]?.id &&
      c.subject === b[i]?.subject &&
      c.shortId === b[i]?.shortId &&
      c.author === b[i]?.author &&
      c.date === b[i]?.date &&
      c.refs.length === b[i]?.refs.length &&
      c.refs.every((r, j) => r === b[i]?.refs[j]),
  );
}

function syncEqual(a: SyncStatus, b: SyncStatus): boolean {
  return (
    a.branch === b.branch &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.hasRemoteBranch === b.hasRemoteBranch &&
    a.canPush === b.canPush &&
    a.canPull === b.canPull
  );
}

function fileStillPresent(file: SelectedFile, status: WorktreeStatus): boolean {
  if (file.commitId) return true;
  const list = file.staged ? status.staged : status.unstaged;
  return list.some((f) => f.path === file.path);
}

function sameSelectedFile(a: SelectedFile | null, b: SelectedFile): boolean {
  return !!a && a.path === b.path && a.staged === b.staged && a.commitId === b.commitId;
}

/** After stage/unstage, keep focus on a sensible neighbor in the source list. */
function pickAfterToggle(
  wasStaged: boolean,
  sourceIndex: number,
  next: WorktreeStatus,
): SelectedFile | null {
  const primary = wasStaged ? next.staged : next.unstaged;
  const secondary = wasStaged ? next.unstaged : next.staged;
  if (primary.length > 0) {
    const idx = sourceIndex < 0 ? 0 : Math.min(sourceIndex, primary.length - 1);
    return { path: primary[idx].path, staged: wasStaged };
  }
  if (secondary.length > 0) {
    return { path: secondary[0].path, staged: !wasStaged };
  }
  return null;
}

function pickAfterToggleAll(fromStaged: boolean, next: WorktreeStatus): SelectedFile | null {
  if (fromStaged) {
    if (next.unstaged.length > 0) return { path: next.unstaged[0].path, staged: false };
    if (next.staged.length > 0) return { path: next.staged[0].path, staged: true };
  } else {
    if (next.staged.length > 0) return { path: next.staged[0].path, staged: true };
    if (next.unstaged.length > 0) return { path: next.unstaged[0].path, staged: false };
  }
  return null;
}

function CommitDetailsSection({
  commit,
  details,
  loading,
  error,
}: {
  commit: Commit;
  details: CommitDetails | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <section className="commit-details-section">
      <header className="pane-header">Commit details</header>
      <div className="commit-details-scroll">
        {loading && <p className="pane-empty">Loading commit details…</p>}
        {!loading && error && <p className="pane-error">{error}</p>}
        {!loading && !error && details && (
          <dl className="commit-details-list">
            <div className="commit-detail-row">
              <dt>Message</dt>
              <dd className="commit-message">{details.message || commit.subject}</dd>
            </div>
            <div className="commit-detail-row">
              <dt>Commit hash</dt>
              <dd><code>{commit.id}</code></dd>
            </div>
            <div className="commit-detail-row">
              <dt>Parent hashes</dt>
              <dd>
                {details.parents.length > 0
                  ? details.parents.map((parent) => <code key={parent}>{parent}</code>)
                  : "None"}
              </dd>
            </div>
            <div className="commit-detail-row">
              <dt>Author</dt>
              <dd>{commit.author}</dd>
            </div>
            <div className="commit-detail-row">
              <dt>Date</dt>
              <dd>{formatDate(commit.date)}</dd>
            </div>
          </dl>
        )}
      </div>
    </section>
  );
}

export function WorktreeReview({ worktreePath, panelStorage }: WorktreeReviewProps) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [status, setStatus] = useState<WorktreeStatus>(EMPTY_STATUS);
  const [sync, setSync] = useState<SyncStatus>(EMPTY_SYNC);
  const [selectedGraphLine, setSelectedGraphLine] = useState<GraphSelection | null>(null);
  const [commitDetails, setCommitDetails] = useState<CommitDetails | null>(null);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [loadingGraph, setLoadingGraph] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingCommitDetails, setLoadingCommitDetails] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [busyStage, setBusyStage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitDetailsError, setCommitDetailsError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pullBusy, setPullBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [fileMenu, setFileMenu] = useState<FileMenuState | null>(null);

  const pathRef = useRef(worktreePath);
  const selectedGraphLineRef = useRef(selectedGraphLine);
  const selectedRef = useRef(selectedFile);
  const diffRequestRef = useRef(0);
  pathRef.current = worktreePath;
  selectedGraphLineRef.current = selectedGraphLine;
  selectedRef.current = selectedFile;

  const selectedCommitId =
    selectedGraphLine?.kind === "commit" ? selectedGraphLine.id : null;
  const selectedCommit = selectedCommitId
    ? commits.find((commit) => commit.id === selectedCommitId) ?? null
    : null;

  const refreshSync = useCallback(async () => {
    const forPath = worktreePath;
    try {
      const next = await invoke<SyncStatus>("remote_sync_status", {
        path: forPath,
      });
      if (pathRef.current !== forPath) return;
      setSync((prev) => (syncEqual(prev, next) ? prev : next));
    } catch {
      if (pathRef.current !== forPath) return;
      setSync((prev) => (syncEqual(prev, EMPTY_SYNC) ? prev : EMPTY_SYNC));
    }
  }, [worktreePath]);

  const refreshStatus = useCallback(
    async (options?: { silent?: boolean }): Promise<WorktreeStatus | null> => {
      const silent = options?.silent ?? false;
      const forPath = worktreePath;
      if (!silent) setLoadingStatus(true);
      try {
        const next = await invoke<WorktreeStatus>("worktree_status", {
          path: forPath,
        });
        if (pathRef.current !== forPath) return null;
        setStatus((prev) => (statusEqual(prev, next) ? prev : next));
        const sel = selectedRef.current;
        if (sel && !fileStillPresent(sel, next)) {
          setSelectedFile(null);
          setPreview(null);
        }
        if (!silent) setError(null);
        return next;
      } catch (e) {
        if (pathRef.current !== forPath) return null;
        if (!silent) setError(String(e));
        return null;
      } finally {
        if (pathRef.current === forPath && !silent) setLoadingStatus(false);
      }
    },
    [worktreePath],
  );

  const refreshCommits = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      const forPath = worktreePath;
      if (!silent) setLoadingGraph(true);
      try {
        const list = await invoke<Commit[]>("list_commits", {
          path: forPath,
          limit: 80,
        });
        if (pathRef.current !== forPath) return;
        setCommits((prev) => (commitsEqual(prev, list) ? prev : list));
      } catch (e) {
        if (pathRef.current !== forPath) return;
        if (!silent) setError(String(e));
      } finally {
        if (pathRef.current === forPath && !silent) setLoadingGraph(false);
      }
    },
    [worktreePath],
  );

  const loadCommitDetails = useCallback(
    async (commitId: string) => {
      const forPath = worktreePath;
      setLoadingCommitDetails(true);
      setCommitDetailsError(null);
      try {
        const next = await invoke<CommitDetails>("commit_details", {
          path: forPath,
          commit: commitId,
        });
        if (pathRef.current !== forPath) return;
        const line = selectedGraphLineRef.current;
        if (!line || line.kind !== "commit" || line.id !== commitId) return;
        setCommitDetails(next);
        setSelectedFile(
          next.files[0]
            ? { path: next.files[0].path, staged: false, commitId }
            : null,
        );
      } catch (e) {
        if (pathRef.current !== forPath) return;
        const line = selectedGraphLineRef.current;
        if (!line || line.kind !== "commit" || line.id !== commitId) return;
        setCommitDetails(null);
        setCommitDetailsError(String(e));
      } finally {
        if (pathRef.current !== forPath) return;
        const line = selectedGraphLineRef.current;
        if (line?.kind === "commit" && line.id === commitId) {
          setLoadingCommitDetails(false);
        }
      }
    },
    [worktreePath],
  );

  const loadDiff = useCallback(
    async (file: SelectedFile) => {
      const forPath = worktreePath;
      const forFile = file;
      const requestId = ++diffRequestRef.current;
      setLoadingDiff(true);
      setDiffError(null);
      try {
        const next = forFile.commitId
          ? await invoke<FilePreview>("commit_file_preview", {
              path: forPath,
              file: forFile.path,
              commit: forFile.commitId,
            })
          : await invoke<FilePreview>("file_preview", {
              path: forPath,
              file: forFile.path,
              staged: forFile.staged,
            });
        if (pathRef.current !== forPath) return;
        const sel = selectedRef.current;
        if (!sameSelectedFile(sel, forFile)) return;
        setPreview(next);
      } catch (e) {
        if (pathRef.current !== forPath) return;
        const sel = selectedRef.current;
        if (!sameSelectedFile(sel, forFile)) return;
        setPreview(null);
        setDiffError(String(e));
      } finally {
        if (pathRef.current === forPath && diffRequestRef.current === requestId) {
          setLoadingDiff(false);
        }
      }
    },
    [worktreePath],
  );

  useEffect(() => {
    setSelectedGraphLine(null);
    setCommitDetails(null);
    setCommitDetailsError(null);
    setLoadingCommitDetails(false);
    setSelectedFile(null);
    setPreview(null);
    setDiffError(null);
    setCommitOpen(false);
    setCommitMessage("");
    setCommitError(null);
    setActionError(null);
    setFileMenu(null);
    setSync(EMPTY_SYNC);
    setStatus(EMPTY_STATUS);
    setCommits([]);
    void refreshCommits();
    void refreshStatus();
    void refreshSync();
  }, [worktreePath, refreshCommits, refreshStatus, refreshSync]);

  useEffect(() => {
    if (loadingGraph || loadingStatus) return;
    setSelectedGraphLine((previous) => {
      if (previous?.kind === "uncommitted" && status.hasChanges) return previous;
      if (previous?.kind === "commit" && commits.some((commit) => commit.id === previous.id)) {
        return previous;
      }
      if (status.hasChanges) return { kind: "uncommitted" };
      return commits[0] ? { kind: "commit", id: commits[0].id } : null;
    });
  }, [commits, loadingGraph, loadingStatus, status.hasChanges]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshStatus({ silent: true });
      void refreshCommits({ silent: true });
      void refreshSync();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refreshStatus, refreshCommits, refreshSync]);

  useEffect(() => {
    setCommitDetails(null);
    setCommitDetailsError(null);
    setSelectedFile(null);
    setPreview(null);
    setDiffError(null);
    if (!selectedCommitId) {
      setLoadingCommitDetails(false);
      return;
    }
    void loadCommitDetails(selectedCommitId);
  }, [selectedCommitId, loadCommitDetails]);

  useEffect(() => {
    if (!selectedFile) {
      setPreview(null);
      return;
    }
    void loadDiff(selectedFile);
  }, [selectedFile, loadDiff]);

  function handleGraphSelection(selection: GraphSelection) {
    setSelectedGraphLine(selection);
    setSelectedFile(null);
    setPreview(null);
    setDiffError(null);
  }

  function handleFileContextMenu(event: React.MouseEvent, path: string) {
    event.preventDefault();
    event.stopPropagation();
    setFileMenu({ x: event.clientX, y: event.clientY, path });
  }

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
      setSelectedFile(pickAfterToggle(wasStaged, sourceIndex, next));
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
      setSelectedGraphLine(null);
      setCommits([]);
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
      setSelectedFile(pickAfterToggleAll(staged, next));
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
              : sync.hasRemoteBranch && sync.ahead > 0
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
              selected={selectedGraphLine}
              onSelect={handleGraphSelection}
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
                        {selectedCommit ? (
                          <CommitFileSection
                            commitId={selectedCommit.id}
                            files={commitDetails?.files ?? []}
                            selected={selectedFile}
                            loading={loadingCommitDetails}
                            onSelectFile={setSelectedFile}
                            onContextMenu={handleFileContextMenu}
                          />
                        ) : (
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
                            onContextMenu={handleFileContextMenu}
                          />
                        )}
                      </div>
                    </Panel>

                    <PanelResizeHandle className="resize-handle horizontal" />

                    <Panel defaultSize={50} minSize={15}>
                      <div className="panel-fill">
                        {selectedCommit ? (
                          <CommitDetailsSection
                            commit={selectedCommit}
                            details={commitDetails}
                            loading={loadingCommitDetails}
                            error={commitDetailsError}
                          />
                        ) : (
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
                            onContextMenu={handleFileContextMenu}
                          />
                        )}
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

      {fileMenu && (
        <ContextMenu
          x={fileMenu.x}
          y={fileMenu.y}
          items={[
            {
              id: "copy-path",
              label: "Copy path",
              onClick: () => void copyPath(fileMenu.path),
            },
            {
              id: "copy-full-path",
              label: "Copy full path",
              onClick: () => void copyPath(fullFilePath(worktreePath, fileMenu.path)),
            },
          ] satisfies ContextMenuItem[]}
          onClose={() => setFileMenu(null)}
        />
      )}
    </div>
  );
}

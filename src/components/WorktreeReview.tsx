import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type PanelGroupStorage,
} from "react-resizable-panels";
import type {
  Commit,
  FilePreview,
  SelectedFile,
  StatusFile,
  WorktreeStatus,
} from "../types";

import { CommitGraph } from "./CommitGraph";
import { DiffView } from "./DiffView";
import { StatusFileSection } from "./StatusFiles";

const REFRESH_MS = 10000;

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

  const refreshStatus = useCallback(async (): Promise<WorktreeStatus | null> => {
    setLoadingStatus(true);
    try {
      const next = await invoke<WorktreeStatus>("worktree_status", {
        path: worktreePath,
      });
      setStatus(next);
      setError(null);
      return next;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setLoadingStatus(false);
    }
  }, [worktreePath]);


  const refreshCommits = useCallback(async () => {
    setLoadingGraph(true);
    try {
      const list = await invoke<Commit[]>("list_commits", {
        path: worktreePath,
        limit: 80,
      });
      setCommits(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingGraph(false);
    }
  }, [worktreePath]);

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
    void refreshCommits();
    void refreshStatus();
  }, [worktreePath, refreshCommits, refreshStatus]);



  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshStatus();
      void refreshCommits();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refreshStatus, refreshCommits]);

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

      const next = await refreshStatus();
      if (!next) return;

      if (wasStaged) {
        // Unstaged: prefer next remaining staged, else first unstaged.
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
        // Staged: prefer next remaining unstaged, else first staged.
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

  async function handleCommit() {
    if (!commitOpen) {
      setCommitOpen(true);
      setCommitError(null);
      return;
    }

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
      await refreshStatus();
      await refreshCommits();
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

      const next = await refreshStatus();
      if (!next) return;

      if (staged) {
        // All unstaged → select first unstaged (or first remaining staged).
        if (next.unstaged.length > 0) {
          setSelectedFile({ path: next.unstaged[0].path, staged: false });
        } else if (next.staged.length > 0) {
          setSelectedFile({ path: next.staged[0].path, staged: true });
        } else {
          setSelectedFile(null);
        }
      } else if (next.staged.length > 0) {
        // All staged → select first staged.
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

  return (
    <div className="worktree-review">
      {error && <p className="review-error">{error}</p>}

      <div className="commit-float">
        {commitOpen && (
          <div className="commit-popover" role="dialog" aria-label="Commit changes">
            <label className="commit-label" htmlFor="commit-message">
              Commit message
            </label>
            <textarea
              id="commit-message"
              className="commit-textarea"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Describe your changes…"
              rows={4}
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

        {!commitOpen && (
          <button
            type="button"
            className="commit-btn primary commit-fab"
            onClick={() => void handleCommit()}
            disabled={!canCommit || busyStage}
            title={
              canCommit
                ? `Commit ${status.staged.length} staged file(s)`
                : "Stage files to commit"
            }
          >
            Commit{canCommit ? ` (${status.staged.length})` : ""}
          </button>
        )}
      </div>

      <PanelGroup
        direction="vertical"
        autoSaveId="canopy-worktree-vertical"
        storage={panelStorage}
        className="review-panels"
      >
        {/* Default: graph 1/3, review 2/3 */}
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
              {/* Default: files 1/2, diff 1/2 */}
              <Panel defaultSize={50} minSize={20}>
                <div className="panel-fill">
                  <PanelGroup
                    direction="vertical"
                    autoSaveId="canopy-worktree-files"
                    storage={panelStorage}
                    className="review-panels files-pane"
                  >
                    {/* Default: staged 1/2, unstaged 1/2 */}
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


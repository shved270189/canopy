import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { loadProjects, saveProjects } from "../storage";
import type { Branch, Project, ProjectTab, Selection, Worktree } from "../types";

const POLL_MS = 10000;

type ProjectSidebarProps = {
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
};

function Spinner({ label }: { label: string }) {
  return (
    <span className="spinner-wrap" role="status" aria-label={label}>
      <span className="project-spinner" aria-hidden />
    </span>
  );
}

export function ProjectSidebar({ selection, onSelect }: ProjectSidebarProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsReady, setProjectsReady] = useState(false);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Record<string, ProjectTab>>({});
  const [worktrees, setWorktrees] = useState<Record<string, Worktree[]>>({});
  const [branches, setBranches] = useState<Record<string, Branch[]>>({});
  const [loadingWorktrees, setLoadingWorktrees] = useState<Record<string, boolean>>({});
  const [loadingBranches, setLoadingBranches] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const expandedPathRef = useRef(expandedPath);
  const activeTabRef = useRef(activeTab);
  const worktreesRef = useRef(worktrees);
  const branchesRef = useRef(branches);
  const loadingWorktreesRef = useRef(loadingWorktrees);
  const loadingBranchesRef = useRef(loadingBranches);

  useEffect(() => {
    expandedPathRef.current = expandedPath;
  }, [expandedPath]);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);


  useEffect(() => {
    worktreesRef.current = worktrees;
  }, [worktrees]);

  useEffect(() => {
    branchesRef.current = branches;
  }, [branches]);

  useEffect(() => {
    loadingWorktreesRef.current = loadingWorktrees;
  }, [loadingWorktrees]);

  useEffect(() => {
    loadingBranchesRef.current = loadingBranches;
  }, [loadingBranches]);

  useEffect(() => {
    let cancelled = false;
    void loadProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        setProjectsReady(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setProjectsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectsReady) return;
    void saveProjects(projects).catch((e) => setError(String(e)));
  }, [projects, projectsReady]);

  const loadWorktrees = useCallback(
    async (projectPath: string, options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      if (!silent) {
        setError(null);
      }

      try {
        const basic = await invoke<Worktree[]>("list_worktrees", {
          path: projectPath,
        });
        setWorktrees((prev) => ({ ...prev, [projectPath]: basic }));
        setLoadingWorktrees((prev) => ({ ...prev, [projectPath]: false }));

        const full = await invoke<Worktree[]>("list_worktrees_with_status", {
          path: projectPath,
        });
        setWorktrees((prev) => ({ ...prev, [projectPath]: full }));
      } catch (e) {
        if (!silent) {
          setError(String(e));
        }
        if (!(projectPath in worktreesRef.current)) {
          setWorktrees((prev) => ({ ...prev, [projectPath]: [] }));
        }
        setLoadingWorktrees((prev) => ({ ...prev, [projectPath]: false }));
      }
    },
    [],
  );

  const loadBranches = useCallback(
    async (projectPath: string, options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      if (!silent) {
        setError(null);
      }

      try {
        const list = await invoke<Branch[]>("list_branches", {
          path: projectPath,
        });
        setBranches((prev) => ({ ...prev, [projectPath]: list }));
      } catch (e) {
        if (!silent) {
          setError(String(e));
        }
        if (!(projectPath in branchesRef.current)) {
          setBranches((prev) => ({ ...prev, [projectPath]: [] }));
        }
      } finally {
        setLoadingBranches((prev) => ({ ...prev, [projectPath]: false }));
      }
    },
    [],
  );

  const refreshExpanded = useCallback(async () => {
    const path = expandedPathRef.current;
    if (!path) return;

    const tab = activeTabRef.current[path] ?? "worktrees";
    if (tab === "worktrees") {
      if (loadingWorktreesRef.current[path]) return;
      setLoadingWorktrees((prev) => ({ ...prev, [path]: true }));
      await loadWorktrees(path, { silent: true });
      return;
    }

    if (loadingBranchesRef.current[path]) return;
    setLoadingBranches((prev) => ({ ...prev, [path]: true }));
    await loadBranches(path, { silent: true });
  }, [loadWorktrees, loadBranches]);

  useEffect(() => {
    if (!expandedPath) return;

    const id = window.setInterval(() => {
      void refreshExpanded();
    }, POLL_MS);

    const onFocus = () => {
      void refreshExpanded();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [expandedPath, refreshExpanded]);


  async function handleAddProject() {
    setError(null);
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Git repository",
    });

    if (selected === null) return;

    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return;

    if (projects.some((p) => p.path === path)) {
      setError("Project already added");
      return;
    }

    try {
      const project = await invoke<Project>("validate_project", { path });
      setProjects((prev) => [...prev, project]);
    } catch (e) {
      setError(String(e));
    }
  }

  function toggleProject(projectPath: string) {
    const closing = expandedPath === projectPath;
    const tab: ProjectTab = activeTab[projectPath] ?? "worktrees";

    flushSync(() => {
      if (closing) {
        setExpandedPath(null);
        setLoadingWorktrees((prev) => ({ ...prev, [projectPath]: false }));
        setLoadingBranches((prev) => ({ ...prev, [projectPath]: false }));
        return;
      }

      // Accordion: only one project open.
      setExpandedPath(projectPath);
      setActiveTab((prev) => ({ ...prev, [projectPath]: tab }));

      if (tab === "branches") {
        setLoadingBranches((prev) => ({ ...prev, [projectPath]: true }));
        setLoadingWorktrees((prev) => ({ ...prev, [projectPath]: false }));
      } else {
        setLoadingWorktrees((prev) => ({ ...prev, [projectPath]: true }));
        setLoadingBranches((prev) => ({ ...prev, [projectPath]: false }));
      }
    });

    if (closing) return;

    if (tab === "branches") {
      const hasCache = Object.prototype.hasOwnProperty.call(
        branchesRef.current,
        projectPath,
      );
      void loadBranches(projectPath, { silent: hasCache });
      return;
    }

    const hasCache = Object.prototype.hasOwnProperty.call(
      worktreesRef.current,
      projectPath,
    );
    void loadWorktrees(projectPath, { silent: hasCache });
  }



  function selectTab(projectPath: string, tab: ProjectTab) {
    if (expandedPath !== projectPath) return;

    setActiveTab((prev) => ({ ...prev, [projectPath]: tab }));

    if (tab === "worktrees") {
      const hasCache = Object.prototype.hasOwnProperty.call(
        worktreesRef.current,
        projectPath,
      );
      flushSync(() => {
        setLoadingWorktrees((prev) => ({ ...prev, [projectPath]: true }));
      });
      void loadWorktrees(projectPath, { silent: hasCache });
      return;
    }

    const hasCache = Object.prototype.hasOwnProperty.call(
      branchesRef.current,
      projectPath,
    );
    flushSync(() => {
      setLoadingBranches((prev) => ({ ...prev, [projectPath]: true }));
    });
    void loadBranches(projectPath, { silent: hasCache });
  }


  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h1 className="sidebar-title">Projects</h1>
        <button type="button" className="add-project-btn" onClick={handleAddProject}>
          Add Project
        </button>
      </header>

      {error && <p className="sidebar-error">{error}</p>}

      <ul className="project-list">
        {projects.length === 0 && (
          <li className="project-empty">No projects yet</li>
        )}

        {projects.map((project) => {
          const isOpen = expandedPath === project.path;
          const tab = activeTab[project.path] ?? "worktrees";
          const wtLoading = !!loadingWorktrees[project.path];
          const brLoading = !!loadingBranches[project.path];
          const hasWtCache = Object.prototype.hasOwnProperty.call(
            worktrees,
            project.path,
          );
          const hasBrCache = Object.prototype.hasOwnProperty.call(
            branches,
            project.path,
          );
          const wtList = worktrees[project.path] ?? [];
          const brList = branches[project.path] ?? [];
          const isLoading = tab === "worktrees" ? wtLoading : brLoading;

          return (
            <li key={project.path} className="project-item">
              <button
                type="button"
                className="project-row"
                onClick={() => toggleProject(project.path)}
                title={project.path}
              >
                <span className={`chevron ${isOpen ? "open" : ""}`} aria-hidden>
                  ▶
                </span>
                <span className="project-name">{project.name}</span>
                {isOpen && isLoading && <Spinner label="Loading" />}
              </button>

              {isOpen && (
                <div className="project-body">
                  <div className="project-tabs" role="tablist">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === "worktrees"}
                      className={`project-tab ${tab === "worktrees" ? "active" : ""}`}
                      onClick={() => selectTab(project.path, "worktrees")}
                    >
                      Worktrees
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === "branches"}
                      className={`project-tab ${tab === "branches" ? "active" : ""}`}
                      onClick={() => selectTab(project.path, "branches")}
                    >
                      Branches
                    </button>
                  </div>

                  {tab === "worktrees" && (
                    <ul className="worktree-list" role="tabpanel">
                      {!hasWtCache && wtLoading && (
                        <li className="worktree-meta worktree-loading">
                          <Spinner label="Loading worktrees" />
                          <span>Loading worktrees…</span>
                        </li>
                      )}
                      {hasWtCache && wtLoading && wtList.length === 0 && (
                        <li className="worktree-meta worktree-loading">
                          <Spinner label="Refreshing worktrees" />
                          <span>Refreshing…</span>
                        </li>
                      )}
                      {hasWtCache && wtList.length === 0 && !wtLoading && (
                        <li className="worktree-meta">No worktrees</li>
                      )}
                      {hasWtCache &&
                        wtList.map((wt) => {
                          const selected =
                            selection?.kind === "worktree" &&
                            selection.path === wt.path;
                          const classes = [
                            "worktree-item",
                            selected ? "selected" : "",
                            wt.hasChanges ? "has-changes" : "",
                            wt.hasStash ? "has-stash" : "",
                            !wt.hasChanges && !wt.hasStash ? "clean" : "",
                          ]
                            .filter(Boolean)
                            .join(" ");

                          const status = [
                            wt.hasChanges ? "uncommitted changes" : null,
                            wt.hasStash ? "stashed changes" : null,
                          ]
                            .filter(Boolean)
                            .join(", ");

                          return (
                            <li key={wt.path}>
                              <button
                                type="button"
                                className={classes}
                                title={status ? `${wt.path} (${status})` : wt.path}
                                onClick={() =>
                                  onSelect({ kind: "worktree", path: wt.path })
                                }
                                aria-selected={selected}
                              >
                                <span className="worktree-name">{wt.name}</span>
                                <span className="worktree-markers" aria-hidden>
                                  {wt.hasChanges && (
                                    <span
                                      className="marker changes"
                                      title="Uncommitted changes"
                                    >
                                      ●
                                    </span>
                                  )}
                                  {wt.hasStash && (
                                    <span className="marker stash" title="Stashed changes">
                                      ▤
                                    </span>
                                  )}
                                </span>
                              </button>
                            </li>
                          );
                        })}

                    </ul>
                  )}

                  {tab === "branches" && (
                    <ul className="branch-list" role="tabpanel">
                      {!hasBrCache && brLoading && (
                        <li className="worktree-meta worktree-loading">
                          <Spinner label="Loading branches" />
                          <span>Loading branches…</span>
                        </li>
                      )}
                      {hasBrCache && brLoading && brList.length === 0 && (
                        <li className="worktree-meta worktree-loading">
                          <Spinner label="Refreshing branches" />
                          <span>Refreshing…</span>
                        </li>
                      )}
                      {hasBrCache && brList.length === 0 && !brLoading && (
                        <li className="worktree-meta">No branches</li>
                      )}
                      {hasBrCache &&
                        brList.map((branch) => {
                          const selected =
                            selection?.kind === "branch" &&
                            selection.name === branch.name &&
                            selection.projectPath === project.path;
                          const classes = [
                            "branch-item",
                            selected ? "selected" : "",
                            branch.isCurrent ? "current" : "",
                            branch.isRemote ? "remote" : "local",
                          ]
                            .filter(Boolean)
                            .join(" ");

                          return (
                            <li
                              key={`${branch.isRemote ? "r" : "l"}:${branch.name}`}
                            >
                              <button
                                type="button"
                                className={classes}
                                title={branch.name}
                                onClick={() =>
                                  onSelect({
                                    kind: "branch",
                                    name: branch.name,
                                    projectPath: project.path,
                                  })
                                }
                                aria-selected={selected}
                              >
                                <span className="branch-name">{branch.name}</span>
                                {branch.isCurrent && (
                                  <span className="branch-current-tag">current</span>
                                )}
                              </button>
                            </li>
                          );
                        })}

                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

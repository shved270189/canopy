import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Folder, FolderPlus, FolderTree } from "lucide-react";
import { loadProjects, saveProjects } from "../storage";
import type { Project, Selection, Worktree } from "../types";
import { AddWorktreeModal } from "./AddWorktreeModal";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

const POLL_MS = 5000;

type ProjectSidebarProps = {
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
};

type MenuState = {
  x: number;
  y: number;
  items: ContextMenuItem[];
};

type ProjectTrees = {
  root: Worktree | null;
  extras: Worktree[];
};

function Spinner({ label }: { label: string }) {
  return (
    <span className="spinner-wrap" role="status" aria-label={label}>
      <span className="project-spinner" aria-hidden />
    </span>
  );
}

function pickRoot(all: Worktree[], projectPath: string): Worktree | null {
  return all.find((wt) => wt.path === projectPath) ?? all[0] ?? null;
}

function splitTrees(
  all: Worktree[],
  projectPath: string,
  extraPaths: string[],
): ProjectTrees {
  const root = pickRoot(all, projectPath);
  const byPath = new Map(all.map((wt) => [wt.path, wt]));
  const extras = extraPaths
    .filter((path) => path !== root?.path)
    .map((path) => byPath.get(path))
    .filter((wt): wt is Worktree => wt != null);
  return { root, extras };
}

function extraPathsFor(project: Project): string[] {
  return project.worktrees.filter((path) => path !== project.path);
}

function branchLabel(wt: Worktree | null): string | null {
  if (!wt) return null;
  return wt.branch ?? wt.name;
}

function WorktreeRow({
  wt,
  project,
  selected,
  onSelect,
  onContextMenu,
}: {
  wt: Worktree;
  project: Project;
  selected: boolean;
  onSelect: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, project: Project, wt: Worktree) => void;
}) {
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
    <li>
      <button
        type="button"
        className={classes}
        title={status ? `${wt.path} (${status})` : wt.path}
        onClick={() => onSelect(wt.path)}
        onContextMenu={(e) => onContextMenu(e, project, wt)}
        aria-selected={selected}
      >
        <span className="worktree-name">{wt.branch ?? wt.name}</span>
        <span className="worktree-markers" aria-hidden>
          {wt.hasChanges && (
            <span className="marker changes" title="Uncommitted changes">
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
}

export function ProjectSidebar({ selection, onSelect }: ProjectSidebarProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsReady, setProjectsReady] = useState(false);
  const [trees, setTrees] = useState<Record<string, ProjectTrees>>({});
  const [loadingWorktrees, setLoadingWorktrees] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [addForProject, setAddForProject] = useState<Project | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const projectsRef = useRef(projects);
  const treesRef = useRef(trees);
  const loadingWorktreesRef = useRef(loadingWorktrees);
  const selectionRef = useRef(selection);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    treesRef.current = trees;
  }, [trees]);

  useEffect(() => {
    loadingWorktreesRef.current = loadingWorktrees;
  }, [loadingWorktrees]);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    let cancelled = false;
    void loadProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(
          list.map((p) => ({
            ...p,
            worktrees: (p.worktrees ?? []).filter((path) => path !== p.path),
          })),
        );
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
    async (
      projectPath: string,
      options?: { silent?: boolean; extraPaths?: string[]; withStatus?: boolean },
    ) => {
      const silent = options?.silent ?? false;
      const withStatus = options?.withStatus ?? true;
      if (!silent) {
        setError(null);
      }

      const project = projectsRef.current.find((p) => p.path === projectPath);
      const extras =
        options?.extraPaths ??
        (project ? extraPathsFor(project) : []);

      try {
        const basic = await invoke<Worktree[]>("list_worktrees", {
          path: projectPath,
        });
        setTrees((prev) => ({
          ...prev,
          [projectPath]: splitTrees(basic, projectPath, extras),
        }));
        setLoadingWorktrees((prev) => ({ ...prev, [projectPath]: false }));

        if (withStatus) {
          const full = await invoke<Worktree[]>("list_worktrees_with_status", {
            path: projectPath,
          });
          setTrees((prev) => ({
            ...prev,
            [projectPath]: splitTrees(full, projectPath, extras),
          }));
        }
      } catch (e) {
        if (!silent) {
          setError(String(e));
        }
        if (!(projectPath in treesRef.current)) {
          setTrees((prev) => ({
            ...prev,
            [projectPath]: { root: null, extras: [] },
          }));
        }
        setLoadingWorktrees((prev) => ({ ...prev, [projectPath]: false }));
      }
    },
    [],
  );

  const refreshAllProjects = useCallback(async () => {
    const list = projectsRef.current;
    if (list.length === 0) return;

    await Promise.all(
      list.map((project) => {
        if (loadingWorktreesRef.current[project.path]) {
          return Promise.resolve();
        }
        return loadWorktrees(project.path, { silent: true, withStatus: true });
      }),
    );
  }, [loadWorktrees]);

  const projectPathsKey = projects.map((p) => p.path).join("\0");
  useEffect(() => {
    if (!projectsReady || projects.length === 0) return;
    for (const project of projects) {
      if (!(project.path in treesRef.current)) {
        setLoadingWorktrees((prev) => ({ ...prev, [project.path]: true }));
      }
      void loadWorktrees(project.path, {
        silent: project.path in treesRef.current,
      });
    }
  }, [projectsReady, projectPathsKey, loadWorktrees, projects]);

  // Pause poll while Add worktree modal open so modal list stays stable.
  useEffect(() => {
    if (!projectsReady || projects.length === 0 || addForProject) return;

    const id = window.setInterval(() => {
      void refreshAllProjects();
    }, POLL_MS);

    const onFocus = () => {
      void refreshAllProjects();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refreshAllProjects();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [projectsReady, projects.length, refreshAllProjects, addForProject]);

  function clearSelectionIfProject(project: Project) {
    const sel = selectionRef.current;
    if (!sel) return;
    if (sel.path === project.path || project.worktrees.includes(sel.path)) {
      onSelect(null);
      return;
    }
    const entry = treesRef.current[project.path];
    if (!entry) return;
    if (entry.root?.path === sel.path) {
      onSelect(null);
      return;
    }
    if (entry.extras.some((w) => w.path === sel.path)) {
      onSelect(null);
    }
  }

  function rootPathFor(projectPath: string): string {
    return treesRef.current[projectPath]?.root?.path ?? projectPath;
  }

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
      setProjects((prev) => [...prev, { ...project, worktrees: [] }]);
    } catch (e) {
      setError(String(e));
    }
  }

  function handleProjectClick(projectPath: string) {
    onSelect({ kind: "worktree", path: rootPathFor(projectPath) });
    void loadWorktrees(projectPath, { silent: true });
  }

  function handleAddWorktree(worktree: Worktree) {
    if (!addForProject) return;
    const projectPath = addForProject.path;

    if (
      worktree.path === projectPath ||
      worktree.path === rootPathFor(projectPath)
    ) {
      setAddForProject(null);
      onSelect({ kind: "worktree", path: worktree.path });
      void loadWorktrees(projectPath, { silent: true });
      return;
    }

    const nextExtras = addForProject.worktrees.includes(worktree.path)
      ? extraPathsFor(addForProject)
      : [...extraPathsFor(addForProject), worktree.path];

    setProjects((prev) => {
      const next = prev.map((p) =>
        p.path === projectPath ? { ...p, worktrees: nextExtras } : p,
      );
      projectsRef.current = next;
      return next;
    });

    setAddForProject(null);
    onSelect({ kind: "worktree", path: worktree.path });
    void loadWorktrees(projectPath, {
      silent: true,
      extraPaths: nextExtras,
    });
  }

  function closeWorktreeFromList(projectPath: string, worktreePath: string) {
    if (
      worktreePath === projectPath ||
      worktreePath === rootPathFor(projectPath)
    ) {
      return;
    }

    const project = projectsRef.current.find((p) => p.path === projectPath);
    if (!project) return;

    const nextExtras = extraPathsFor(project).filter((p) => p !== worktreePath);

    setProjects((prev) => {
      const next = prev.map((p) =>
        p.path === projectPath ? { ...p, worktrees: nextExtras } : p,
      );
      projectsRef.current = next;
      return next;
    });

    setTrees((prev) => {
      const entry = prev[projectPath];
      if (!entry) return prev;
      return {
        ...prev,
        [projectPath]: {
          ...entry,
          extras: entry.extras.filter((w) => w.path !== worktreePath),
        },
      };
    });

    if (selectionRef.current?.path === worktreePath) {
      onSelect({ kind: "worktree", path: rootPathFor(projectPath) });
    }
  }

  async function deleteWorktree(projectPath: string, worktreePath: string) {
    if (
      worktreePath === projectPath ||
      worktreePath === rootPathFor(projectPath)
    ) {
      return;
    }

    const confirmed = window.confirm(
      `Delete worktree from git?\n\n${worktreePath}\n\nThis removes the worktree directory.`,
    );
    if (!confirmed) return;

    setError(null);
    try {
      await invoke("remove_worktree", {
        repo: projectPath,
        path: worktreePath,
        force: true,
      });
      closeWorktreeFromList(projectPath, worktreePath);
    } catch (e) {
      setError(String(e));
    }
  }

  function closeProject(project: Project) {
    clearSelectionIfProject(project);

    setProjects((prev) => {
      const next = prev.filter((p) => p.path !== project.path);
      projectsRef.current = next;
      return next;
    });

    setTrees((prev) => {
      const next = { ...prev };
      delete next[project.path];
      return next;
    });
  }

  function openProjectMenu(e: React.MouseEvent, project: Project) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          id: "open-worktree",
          label: "Open worktree",
          onClick: () => setAddForProject(project),
        },
        {
          id: "close-project",
          label: "Close",
          onClick: () => closeProject(project),
        },
      ],
    });
  }

  function openWorktreeMenu(
    e: React.MouseEvent,
    project: Project,
    wt: Worktree,
  ) {
    e.preventDefault();
    e.stopPropagation();

    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          id: "close-worktree",
          label: "Close",
          onClick: () => closeWorktreeFromList(project.path, wt.path),
        },
        {
          id: "delete-worktree",
          label: "Delete",
          danger: true,
          onClick: () => {
            void deleteWorktree(project.path, wt.path);
          },
        },
      ],
    });
  }

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h1 className="sidebar-title">Projects</h1>
        <button
          type="button"
          className="icon-btn"
          onClick={handleAddProject}
          aria-label="Add project"
          title="Add project"
        >
          <FolderPlus size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </header>

      {error && <p className="sidebar-error">{error}</p>}

      <ul className="project-list">
        {projects.length === 0 && (
          <li className="project-empty">No projects yet</li>
        )}

        {projects.map((project) => {
          const entry = trees[project.path];
          const root = entry?.root ?? null;
          const extras = entry?.extras ?? [];
          const wtLoading = !!loadingWorktrees[project.path];
          const hasCache = project.path in trees;
          const branch = branchLabel(root);
          const rootSelected =
            selection?.kind === "worktree" &&
            !!root &&
            selection.path === root.path;

          return (
            <li key={project.path} className="project-item">
              <div
                className={`project-row-wrap${rootSelected ? " selected" : ""}`}
                onContextMenu={(e) => openProjectMenu(e, project)}
              >
                <button
                  type="button"
                  className="project-row"
                  onClick={() => handleProjectClick(project.path)}
                  onContextMenu={(e) => openProjectMenu(e, project)}
                  title={project.path}
                >
                  <span className="project-folder-icon" aria-hidden>
                    <Folder size={14} strokeWidth={1.75} />
                  </span>
                  <span className="project-name">{project.name}</span>
                  {branch && (
                    <span className="project-branch">({branch})</span>
                  )}
                  {wtLoading && !hasCache && <Spinner label="Loading" />}
                </button>
                <button
                  type="button"
                  className="icon-btn project-add-worktree"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAddForProject(project);
                  }}
                  aria-label={`Add worktree to ${project.name}`}
                  title="Add worktree"
                >
                  <FolderTree size={14} strokeWidth={1.75} aria-hidden />
                </button>
              </div>

              {extras.length > 0 && (
                <div className="project-body">
                  <ul className="worktree-list">
                    {extras.map((wt) => (
                      <WorktreeRow
                        key={wt.path}
                        wt={wt}
                        project={project}
                        selected={
                          selection?.kind === "worktree" &&
                          selection.path === wt.path
                        }
                        onSelect={(path) =>
                          onSelect({ kind: "worktree", path })
                        }
                        onContextMenu={openWorktreeMenu}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {addForProject && (
        <AddWorktreeModal
          projectPath={addForProject.path}
          projectName={addForProject.name}
          addedPaths={[
            rootPathFor(addForProject.path),
            ...extraPathsFor(addForProject),
          ]}
          onAdd={handleAddWorktree}
          onClose={() => setAddForProject(null)}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  );
}

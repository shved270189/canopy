import { invoke } from "@tauri-apps/api/core";
import type { Project } from "./types";

const LEGACY_KEY = "canopy.projects";

function normalizeProject(raw: Partial<Project> & { path: string; name: string }): Project {
  return {
    path: raw.path,
    name: raw.name,
    worktrees: Array.isArray(raw.worktrees) ? raw.worktrees : [],
  };
}

export async function loadProjects(): Promise<Project[]> {
  const projects = await invoke<Project[]>("load_projects");
  if (projects.length > 0) {
    return projects.map(normalizeProject);
  }

  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const legacy = JSON.parse(raw) as Project[];
    if (!Array.isArray(legacy) || legacy.length === 0) return [];
    const normalized = legacy.map(normalizeProject);
    await saveProjects(normalized);
    localStorage.removeItem(LEGACY_KEY);
    return normalized;
  } catch {
    return [];
  }
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await invoke("save_projects", { projects });
}

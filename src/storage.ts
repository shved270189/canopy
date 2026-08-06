import { invoke } from "@tauri-apps/api/core";
import type { Project } from "./types";

const LEGACY_KEY = "canopy.projects";

export async function loadProjects(): Promise<Project[]> {
  const projects = await invoke<Project[]>("load_projects");
  if (projects.length > 0) {
    return projects;
  }

  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const legacy = JSON.parse(raw) as Project[];
    if (!Array.isArray(legacy) || legacy.length === 0) return [];
    await saveProjects(legacy);
    localStorage.removeItem(LEGACY_KEY);
    return legacy;
  } catch {
    return [];
  }
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await invoke("save_projects", { projects });
}

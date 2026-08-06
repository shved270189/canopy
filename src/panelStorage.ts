import { invoke } from "@tauri-apps/api/core";
import type { PanelGroupStorage } from "react-resizable-panels";

const cache: Record<string, string> = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    void invoke("save_panel_layouts", { layouts: { ...cache } }).catch(() => {
      /* ignore persistence errors while resizing */
    });
  }, 200);
}

export async function initPanelStorage(): Promise<void> {
  try {
    const layouts = await invoke<Record<string, string>>("load_panel_layouts");
    Object.assign(cache, layouts ?? {});
  } catch {
    /* first launch or offline — keep empty cache */
  }
}

/** File-backed storage for react-resizable-panels (sync API + async persist). */
export function createPanelStorage(): PanelGroupStorage {
  return {
    getItem(name: string) {
      return Object.prototype.hasOwnProperty.call(cache, name) ? cache[name] : null;
    },
    setItem(name: string, value: string) {
      cache[name] = value;
      scheduleSave();
    },
  };
}

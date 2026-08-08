import { useEffect, useMemo, useState } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type PanelGroupStorage,
} from "react-resizable-panels";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { WorktreeReview } from "./components/WorktreeReview";
import { createPanelStorage, initPanelStorage } from "./panelStorage";
import type { Selection } from "./types";
import "./App.css";

function App() {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const panelStorage = useMemo<PanelGroupStorage>(() => createPanelStorage(), []);

  useEffect(() => {
    let cancelled = false;
    void initPanelStorage().finally(() => {
      if (!cancelled) setStorageReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!storageReady) {
    return (
      <div className="app-shell">
        <p className="main-placeholder">Loading…</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <PanelGroup
        direction="horizontal"
        autoSaveId="canopy-app-shell"
        storage={panelStorage}
        className="app-panels"
      >
        <Panel defaultSize={22} minSize={14} maxSize={45}>
          <div className="panel-fill">
            <ProjectSidebar
              selection={selection}
              onSelect={setSelection}
            />
          </div>
        </Panel>

        <PanelResizeHandle className="resize-handle vertical" />

        <Panel defaultSize={78} minSize={40}>
          <div className="panel-fill">
            <main className="main-pane">
              {selection ? (
                <WorktreeReview
                  worktreePath={selection.path}
                  panelStorage={panelStorage}
                />
              ) : (
                <p className="main-placeholder">Select a worktree to review</p>
              )}
            </main>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}

export default App;

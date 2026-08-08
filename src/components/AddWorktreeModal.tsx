import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Worktree } from "../types";

type AddWorktreeModalProps = {
  projectPath: string;
  projectName: string;
  addedPaths: string[];
  onAdd: (worktree: Worktree) => void;
  onClose: () => void;
};

export function AddWorktreeModal({
  projectPath,
  projectName,
  addedPaths,
  onAdd,
  onClose,
}: AddWorktreeModalProps) {
  const [query, setQuery] = useState("");
  const [available, setAvailable] = useState<Worktree[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Snapshot exclusions at open — ignore parent polls while modal is open.
  const [excluded] = useState(() => new Set(addedPaths));

  useEffect(() => {
    let cancelled = false;

    void invoke<Worktree[]>("list_worktrees", { path: projectPath })
      .then((list) => {
        if (cancelled) return;
        setAvailable(list.filter((wt) => !excluded.has(wt.path)));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setAvailable([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // Load once when modal opens for this project.
  }, [projectPath, excluded]);

  useEffect(() => {
    // Focus after paint; re-run when loading ends (disabled inputs reject focus).
    const id = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [loading]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter((wt) => wt.name.toLowerCase().includes(q));
  }, [available, query]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Add worktree to ${projectName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2 className="modal-title">Add worktree</h2>
          <p className="modal-subtitle">{projectName}</p>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="modal-search">
          <input
            ref={inputRef}
            type="search"
            className="modal-search-input"
            placeholder="Filter by name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            autoFocus
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            name="worktree-filter"
          />
        </div>

        {error && <p className="modal-error">{error}</p>}

        <ul className="modal-list">
          {loading && <li className="modal-empty">Loading worktrees…</li>}
          {!loading && !error && filtered.length === 0 && (
            <li className="modal-empty">
              {available.length === 0
                ? "No worktrees available to add"
                : "No matches"}
            </li>
          )}
          {!loading &&
            filtered.map((wt) => (
              <li key={wt.path}>
                <button
                  type="button"
                  className="modal-list-item"
                  onClick={() => onAdd(wt)}
                >
                  <span className="modal-item-name">{wt.name}</span>
                  <span className="modal-item-path">{wt.path}</span>
                </button>
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}

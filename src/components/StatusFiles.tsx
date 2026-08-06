import type { SelectedFile, StatusFile } from "../types";

type StatusFileSectionProps = {
  title: string;
  files: StatusFile[];
  staged: boolean;
  selected: SelectedFile | null;
  busy: boolean;
  emptyLabel: string;
  onToggleStage: (file: StatusFile) => void;
  onToggleAll: () => void;
  onSelectFile: (file: SelectedFile) => void;
};

function statusIcon(status: string): string {
  switch (status) {
    case "added":
    case "untracked":
      return "+";
    case "deleted":
      return "−";
    case "renamed":
      return "→";
    case "modified":
      return "•";
    default:
      return "?";
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "added":
    case "untracked":
      return "st-added";
    case "deleted":
      return "st-deleted";
    case "modified":
    case "renamed":
      return "st-modified";
    default:
      return "st-other";
  }
}

function FileRow({
  file,
  checked,
  selected,
  disabled,
  onToggle,
  onSelect,
}: {
  file: StatusFile;
  checked: boolean;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  return (
    <li>
      <div className={`status-file ${selected ? "selected" : ""}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          title={checked ? "Unstage file" : "Stage file"}
          aria-label={checked ? `Unstage ${file.path}` : `Stage ${file.path}`}
        />
        <button type="button" className="status-file-btn" onClick={onSelect}>
          <span className={`status-badge ${statusClass(file.status)}`}>
            {statusIcon(file.status)}
          </span>
          <span className="status-path" title={file.path}>
            {file.path}
          </span>
        </button>
      </div>
    </li>
  );
}

export function StatusFileSection({
  title,
  files,
  staged,
  selected,
  busy,
  emptyLabel,
  onToggleStage,
  onToggleAll,
  onSelectFile,
}: StatusFileSectionProps) {
  const hasFiles = files.length > 0;

  return (
    <section className="files-section">
      <header className="pane-header files-header">
        <input
          type="checkbox"
          className="files-header-check"
          checked={staged && hasFiles}
          disabled={busy || !hasFiles}
          onChange={onToggleAll}
          title={
            staged
              ? "Unstage all files"
              : "Stage all files"
          }
          aria-label={
            staged
              ? `Unstage all ${title.toLowerCase()}`
              : `Stage all ${title.toLowerCase()}`
          }
        />
        <span>{title}</span>
        <span className="pane-count">{files.length}</span>
      </header>
      <ul className="status-list">
        {files.length === 0 && (
          <li className="pane-empty-inline">{emptyLabel}</li>
        )}
        {files.map((file) => (
          <FileRow
            key={`${staged ? "s" : "u"}:${file.path}`}
            file={file}
            checked={staged}
            selected={
              !!selected &&
              selected.staged === staged &&
              selected.path === file.path
            }
            disabled={busy}
            onToggle={() => onToggleStage(file)}
            onSelect={() => onSelectFile({ path: file.path, staged })}
          />
        ))}
      </ul>
    </section>
  );
}

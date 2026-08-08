import type { Commit, GraphSelection } from "../types";

type CommitGraphProps = {
  commits: Commit[];
  hasChanges: boolean;
  loading: boolean;
  selected: GraphSelection | null;
  onSelect: (selection: GraphSelection) => void;
};

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `Today at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function refClass(ref: string): string {
  if (ref.startsWith("origin/") || ref.includes("/")) return "ref-remote";
  if (ref === "HEAD") return "ref-head";
  return "ref-local";
}

export function CommitGraph({
  commits,
  hasChanges,
  loading,
  selected,
  onSelect,
}: CommitGraphProps) {
  return (
    <section className="graph-pane">
      <header className="pane-header graph-header">
        <span>Graph</span>
        <span className="pane-header-meta">Description</span>
        <span className="pane-header-meta">Commit</span>
        <span className="pane-header-meta">Author</span>
        <span className="pane-header-meta">Date</span>
      </header>

      <div className="graph-scroll">
        {loading && commits.length === 0 && (
          <p className="pane-empty">Loading history…</p>
        )}
        {!loading && commits.length === 0 && !hasChanges && (
          <p className="pane-empty">No commits</p>
        )}

        <ul className="graph-list">
          {hasChanges && (
            <li>
              <button
                type="button"
                className={`graph-row uncommitted${selected?.kind === "uncommitted" ? " selected" : ""}`}
                aria-pressed={selected?.kind === "uncommitted"}
                onClick={() => onSelect({ kind: "uncommitted" })}
              >
                <div className="graph-lane">
                  <span className="graph-dot open" />
                  <span className="graph-line" />
                </div>
                <div className="graph-body">
                  <span className="graph-subject">Uncommitted changes</span>
                </div>
                <span className="graph-hash">*</span>
                <span className="graph-author">*</span>
                <span className="graph-date">{formatDate(new Date().toISOString())}</span>
              </button>
            </li>
          )}

          {commits.map((commit, index) => (
            <li key={commit.id}>
              <button
                type="button"
                className={`graph-row${selected?.kind === "commit" && selected.id === commit.id ? " selected" : ""}`}
                aria-pressed={selected?.kind === "commit" && selected.id === commit.id}
                onClick={() => onSelect({ kind: "commit", id: commit.id })}
              >
                <div className="graph-lane">
                  <span className="graph-dot" />
                  {index < commits.length - 1 && <span className="graph-line" />}
                </div>
                <div className="graph-body">
                  {commit.refs.length > 0 && (
                    <span className="graph-refs">
                      {commit.refs.map((ref) => (
                        <span key={ref} className={`graph-ref ${refClass(ref)}`}>
                          {ref}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="graph-subject" title={commit.subject}>
                    {commit.subject}
                  </span>
                </div>
                <span className="graph-hash" title={commit.id}>
                  {commit.shortId}
                </span>
                <span className="graph-author" title={commit.author}>
                  {commit.author}
                </span>
                <span className="graph-date">{formatDate(commit.date)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

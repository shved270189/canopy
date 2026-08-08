import { useEffect, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { FilePreview, SelectedFile } from "../types";
import { highlightCode, languageForPath } from "../syntax";

type DiffViewProps = {
  file: SelectedFile | null;
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
};

type DiffLine = {
  kind: "add" | "del" | "ctx" | "meta" | "hunk";
  prefix: string;
  code: string;
};

function classifyLine(text: string): DiffLine {
  if (
    text.startsWith("diff ") ||
    text.startsWith("index ") ||
    text.startsWith("new file") ||
    text.startsWith("deleted file") ||
    text.startsWith("old mode") ||
    text.startsWith("new mode") ||
    text.startsWith("similarity index") ||
    text.startsWith("rename from") ||
    text.startsWith("rename to") ||
    text.startsWith("--- ") ||
    text.startsWith("+++ ") ||
    text.startsWith("---\t") ||
    text.startsWith("+++\t") ||
    text === "---" ||
    text === "+++" ||
    text.startsWith("\\")
  ) {
    return { kind: "meta", prefix: "", code: text };
  }
  if (text.startsWith("@@")) {
    return { kind: "hunk", prefix: "", code: text };
  }
  if (text.startsWith("+")) {
    return { kind: "add", prefix: "+", code: text.slice(1) };
  }
  if (text.startsWith("-")) {
    return { kind: "del", prefix: "-", code: text.slice(1) };
  }
  if (text.startsWith(" ") || text === "") {
    return {
      kind: "ctx",
      prefix: text === "" ? " " : text[0],
      code: text === "" ? "" : text.slice(1),
    };
  }
  return { kind: "ctx", prefix: " ", code: text };
}

export function DiffView({ file, preview, loading, error }: DiffViewProps) {
  const [copiedFile, setCopiedFile] = useState<SelectedFile | null>(null);
  const language = file ? languageForPath(file.path) : null;
  const isCopied =
    !!file &&
    !!copiedFile &&
    copiedFile.path === file.path &&
    copiedFile.staged === file.staged &&
    copiedFile.commitId === file.commitId;

  useEffect(() => {
    if (!copiedFile) return;
    const timeout = window.setTimeout(() => setCopiedFile(null), 1000);
    return () => window.clearTimeout(timeout);
  }, [copiedFile]);

  async function handleCopyPath() {
    if (!file || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(file.path);
      setCopiedFile(file);
    } catch {
      setCopiedFile(null);
    }
  }

  const lines = useMemo(() => {
    if (preview?.kind !== "text") return [];
    return preview.lines.map(classifyLine);
  }, [preview]);

  return (
    <section className="diff-pane">
      <header className="pane-header diff-header">
        {file ? (
          <>
            <div className="diff-file-info">
              <span className="diff-file-path" title={file.path}>
                {file.path}
              </span>
              <button
                type="button"
                className={`diff-copy-path${isCopied ? " copied" : ""}`}
                title={isCopied ? "Copied" : "Copy path"}
                aria-label={isCopied ? "Copied" : "Copy path"}
                onClick={() => void handleCopyPath()}
              >
                {isCopied ? (
                  <Check size={14} strokeWidth={4} aria-hidden />
                ) : (
                  <Copy size={14} strokeWidth={1.75} aria-hidden />
                )}
              </button>
            </div>
            <span className="diff-file-kind">
              {file.commitId ? "committed" : file.staged ? "staged" : "unstaged"}
              {preview?.kind === "image" ? ` · ${preview.label}` : ""}
              {language ? ` · ${language}` : ""}
              {preview?.kind === "text" ? ` · ${preview.lines.length} lines` : ""}
            </span>
          </>
        ) : (
          <span>Diff</span>
        )}
      </header>

      <div className="diff-scroll">
        {!file && <p className="pane-empty">Select a file to view diff</p>}
        {file && loading && <p className="pane-empty">Loading preview…</p>}
        {file && error && <p className="pane-error">{error}</p>}

        {file && !loading && !error && preview?.kind === "image" && (
          <div className="image-preview">
            <img
              className="image-preview-img"
              src={`data:${preview.mime};base64,${preview.base64}`}
              alt={file.path}
            />
          </div>
        )}

        {file && !loading && !error && preview?.kind === "binary" && (
          <p className="pane-empty">{preview.message}</p>
        )}

        {file && !loading && !error && preview?.kind === "text" && lines.length === 0 && (
          <p className="pane-empty">No diff for this file</p>
        )}

        {file && !loading && !error && preview?.kind === "text" && lines.length > 0 && (
          <div className="diff-pre">
            {lines.map((line, i) => {
              const isCode =
                line.kind === "add" || line.kind === "del" || line.kind === "ctx";
              const html = isCode ? highlightCode(line.code, language) : "";

              return (
                <div key={i} className={`diff-line kind-${line.kind}`}>
                  {isCode ? (
                    <>
                      <span className="diff-prefix">{line.prefix || "\u00a0"}</span>
                      <code
                        className="diff-code"
                        dangerouslySetInnerHTML={{
                          __html: html.length > 0 ? html : "\u00a0",
                        }}
                      />
                    </>
                  ) : (
                    <code className="diff-code plain">
                      {line.code.length > 0 ? line.code : "\u00a0"}
                    </code>
                  )}
                </div>
              );
            })}

          </div>
        )}
      </div>
    </section>
  );
}

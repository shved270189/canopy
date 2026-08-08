import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("rust", rust);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("bash", bash);

const EXT_LANG: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  scss: "css",
  html: "xml",
  htm: "xml",
  svg: "xml",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  toml: "bash",
};

/** Rust keywords — used as guaranteed fallback when hljs misses line fragments. */
const RUST_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "const",
  "continue",
  "crate",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
  "union",
  "box",
  "try",
  "yield",
]);

export function languageForPath(path: string): string | null {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_LANG[ext] ?? null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightRustFallback(code: string): string {
  // Tokenize lightly: strings, comments, then keywords/types/numbers.
  let i = 0;
  let out = "";
  const n = code.length;

  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
  const isIdent = (c: string) => /[A-Za-z0-9_]/.test(c);

  while (i < n) {
    // line comment
    if (code[i] === "/" && code[i + 1] === "/") {
      const end = code.length;
      out += `<span class="tok-comment">${escapeHtml(code.slice(i, end))}</span>`;
      break;
    }
    // string
    if (code[i] === '"') {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (code[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      out += `<span class="tok-string">${escapeHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // char
    if (code[i] === "'" && code[i + 1] !== "'") {
      let j = i + 1;
      if (code[j] === "\\" && j + 1 < n) j += 2;
      else j += 1;
      if (code[j] === "'") j += 1;
      out += `<span class="tok-string">${escapeHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // number
    if (/[0-9]/.test(code[i])) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXoObB._]/.test(code[j])) j += 1;
      out += `<span class="tok-number">${escapeHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // ident / keyword / type
    if (isIdentStart(code[i])) {
      let j = i + 1;
      while (j < n && isIdent(code[j])) j += 1;
      const word = code.slice(i, j);
      if (RUST_KEYWORDS.has(word)) {
        out += `<span class="tok-keyword">${escapeHtml(word)}</span>`;
      } else if (/^[A-Z]/.test(word)) {
        out += `<span class="tok-type">${escapeHtml(word)}</span>`;
      } else {
        out += escapeHtml(word);
      }
      i = j;
      continue;
    }
    // attributes start
    if (code[i] === "#" && code[i + 1] === "[") {
      let j = i + 2;
      let depth = 1;
      while (j < n && depth > 0) {
        if (code[j] === "[") depth += 1;
        else if (code[j] === "]") depth -= 1;
        j += 1;
      }
      out += `<span class="tok-attr">${escapeHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    out += escapeHtml(code[i]);
    i += 1;
  }
  return out;
}

/** Highlight source code; returns HTML span tokens. */
export function highlightCode(code: string, language: string | null): string {
  if (!code) return "";
  if (!language) {
    return escapeHtml(code);
  }

  if (language === "rust") {
    try {
      const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
      if (html.includes("hljs-")) return html;
    } catch {
      return highlightRustFallback(code);
    }
    return highlightRustFallback(code);
  }

  if (!hljs.getLanguage(language)) {
    return escapeHtml(code);
  }
  try {
    const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    // If hljs produced no tokens, still escape (shouldn't happen often).
    return html.includes("hljs-") ? html : escapeHtml(code);
  } catch {
    return escapeHtml(code);
  }
}

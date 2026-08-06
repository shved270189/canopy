export type Project = {
  path: string;
  name: string;
};

export type Worktree = {
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  hasChanges: boolean;
  hasStash: boolean;
};

export type Branch = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
};

export type ProjectTab = "worktrees" | "branches";

export type Selection =
  | { kind: "worktree"; path: string }
  | { kind: "branch"; name: string; projectPath: string };

export type Commit = {
  id: string;
  shortId: string;
  author: string;
  date: string;
  subject: string;
  refs: string[];
  parentIds: string[];
};

export type StatusFile = {
  path: string;
  status: string;
  staged: boolean;
};

export type WorktreeStatus = {
  staged: StatusFile[];
  unstaged: StatusFile[];
  hasChanges: boolean;
};

export type SelectedFile = {
  path: string;
  staged: boolean;
};

export type FilePreview =
  | { kind: "text"; lines: string[] }
  | { kind: "image"; mime: string; base64: string; label: string }
  | { kind: "binary"; message: string };

export type Project = {
  path: string;
  name: string;
  worktrees: string[];
};

export type Worktree = {
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  hasChanges: boolean;
  hasStash: boolean;
};

export type Selection = { kind: "worktree"; path: string };

export type Commit = {
  id: string;
  shortId: string;
  author: string;
  date: string;
  subject: string;
  refs: string[];
};

export type CommitFile = {
  path: string;
  status: string;
};

export type CommitDetails = {
  message: string;
  parents: string[];
  files: CommitFile[];
};

export type GraphSelection =
  | { kind: "uncommitted" }
  | { kind: "commit"; id: string };

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

export type SyncStatus = {
  branch: string | null;
  ahead: number;
  behind: number;
  hasRemoteBranch: boolean;
  canPush: boolean;
  canPull: boolean;
};

export type SelectedFile = {
  path: string;
  staged: boolean;
  commitId?: string;
};

export type FilePreview =
  | { kind: "text"; lines: string[] }
  | { kind: "image"; mime: string; base64: string; label: string }
  | { kind: "binary"; message: string };

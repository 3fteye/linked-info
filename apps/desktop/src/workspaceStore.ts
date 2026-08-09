import {
  parseWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from "./workspaceData";

export {
  emptyWorkspace,
  isNodeNameAvailable,
  isUnnamedNode,
  normalizeNodeName,
  type InformationNode,
  type NodeLayout,
  type NodeReference,
  type WorkspaceSnapshot,
} from "./workspaceData";

export type WorkspaceLoadResult =
  | { status: "missing" }
  | { status: "ready"; workspace: WorkspaceSnapshot }
  | { status: "invalid"; raw: string };

export interface WorkspacePersistence {
  load(): Promise<WorkspaceLoadResult>;
  loadRecovery(): Promise<WorkspaceLoadResult>;
  preserveForRecovery(workspace: WorkspaceSnapshot): Promise<void>;
  save(workspace: WorkspaceSnapshot): Promise<void>;
}

const workspaceStorageKey = "linked-info.workspace.v1";
const workspaceRecoveryStorageKey = "linked-info.workspace.recovery.v1";

function loadStoredWorkspace(key: string): WorkspaceLoadResult {
  const raw = localStorage.getItem(key);
  if (raw === null) {
    return { status: "missing" };
  }

  let stored: unknown;
  try {
    stored = JSON.parse(raw) as unknown;
  } catch {
    return { status: "invalid", raw };
  }

  if (
    typeof stored !== "object" ||
    stored === null ||
    !("version" in stored) ||
    stored.version !== 1
  ) {
    return { status: "invalid", raw };
  }

  const workspace = parseWorkspaceSnapshot(stored);
  return workspace === null
    ? { status: "invalid", raw }
    : { status: "ready", workspace };
}

function saveStoredWorkspace(key: string, workspace: WorkspaceSnapshot): void {
  const validated = parseWorkspaceSnapshot(workspace);
  if (validated === null) {
    throw new Error("refusing to persist an invalid workspace snapshot");
  }
  localStorage.setItem(key, JSON.stringify({ version: 1, ...validated }));
}

export const localWorkspacePersistence: WorkspacePersistence = {
  async load() {
    return loadStoredWorkspace(workspaceStorageKey);
  },
  async loadRecovery() {
    return loadStoredWorkspace(workspaceRecoveryStorageKey);
  },
  async preserveForRecovery(workspace) {
    saveStoredWorkspace(workspaceRecoveryStorageKey, workspace);
  },
  async save(workspace) {
    saveStoredWorkspace(workspaceStorageKey, workspace);
  },
};

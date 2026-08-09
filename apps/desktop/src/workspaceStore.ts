export interface InformationNode {
  id: string;
  name: string | null;
  content: string | null;
}

export interface NodeLayout {
  nodeId: string;
  x: number;
  y: number;
}

export interface NodeReference {
  sourceNodeId: string;
  targetNodeId: string;
}

export interface WorkspaceSnapshot {
  nodes: InformationNode[];
  layout: NodeLayout[];
  references: NodeReference[];
}

export interface WorkspacePersistence {
  load(): WorkspaceSnapshot;
  loadRecovery(): WorkspaceSnapshot | null;
  preserveForRecovery(workspace: WorkspaceSnapshot): void;
  save(workspace: WorkspaceSnapshot): void;
}

const workspaceStorageKey = "linked-info.workspace.v1";
const workspaceRecoveryStorageKey = "linked-info.workspace.recovery.v1";

function emptyWorkspace(): WorkspaceSnapshot {
  return { nodes: [], layout: [], references: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readJson(key: string): unknown {
  const value = localStorage.getItem(key);
  if (value === null) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function normalizeNodeName(name: string): string {
  return name.trim().toLowerCase();
}

export function isUnnamedNode(node: InformationNode): boolean {
  return node.name === null || node.name.trim().length === 0;
}

function parseStoredWorkspace(stored: unknown): WorkspaceSnapshot | null {
  if (!isRecord(stored) || stored.version !== 1 || !Array.isArray(stored.nodes)) {
    return null;
  }

  const nodes: InformationNode[] = [];
  const nodeIds = new Set<string>();

  for (const candidate of stored.nodes) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      (candidate.name !== null && typeof candidate.name !== "string") ||
      (candidate.content !== null && typeof candidate.content !== "string")
    ) {
      continue;
    }

    if (nodeIds.has(candidate.id)) {
      continue;
    }

    const name = candidate.name?.trim() || null;
    nodeIds.add(candidate.id);
    nodes.push({
      id: candidate.id,
      name,
      content: candidate.content,
    });
  }

  const layoutByNode = new Map<string, NodeLayout>();
  if (Array.isArray(stored.layout)) {
    for (const candidate of stored.layout) {
      if (
        isRecord(candidate) &&
        typeof candidate.nodeId === "string" &&
        nodeIds.has(candidate.nodeId) &&
        isFiniteNumber(candidate.x) &&
        isFiniteNumber(candidate.y)
      ) {
        layoutByNode.set(candidate.nodeId, {
          nodeId: candidate.nodeId,
          x: candidate.x,
          y: candidate.y,
        });
      }
    }
  }

  const layout = nodes.map((node, index) => {
    return (
      layoutByNode.get(node.id) ?? {
        nodeId: node.id,
        x: 80 + (index % 4) * 300,
        y: 80 + Math.floor(index / 4) * 210,
      }
    );
  });

  const references: NodeReference[] = [];
  const referenceKeys = new Set<string>();
  if (Array.isArray(stored.references)) {
    for (const candidate of stored.references) {
      if (
        !isRecord(candidate) ||
        typeof candidate.sourceNodeId !== "string" ||
        typeof candidate.targetNodeId !== "string" ||
        !nodeIds.has(candidate.sourceNodeId) ||
        !nodeIds.has(candidate.targetNodeId)
      ) {
        continue;
      }

      const key = `${candidate.sourceNodeId}\u0000${candidate.targetNodeId}`;
      if (referenceKeys.has(key)) {
        continue;
      }

      referenceKeys.add(key);
      references.push({
        sourceNodeId: candidate.sourceNodeId,
        targetNodeId: candidate.targetNodeId,
      });
    }
  }

  return { nodes, layout, references };
}

function saveStoredWorkspace(key: string, workspace: WorkspaceSnapshot): void {
  localStorage.setItem(
    key,
    JSON.stringify({ version: 1, ...workspace }),
  );
}

export const localWorkspacePersistence: WorkspacePersistence = {
  load() {
    return parseStoredWorkspace(readJson(workspaceStorageKey)) ?? emptyWorkspace();
  },
  loadRecovery() {
    return parseStoredWorkspace(readJson(workspaceRecoveryStorageKey));
  },
  preserveForRecovery(workspace) {
    saveStoredWorkspace(workspaceRecoveryStorageKey, workspace);
  },
  save(workspace) {
    saveStoredWorkspace(workspaceStorageKey, workspace);
  },
};

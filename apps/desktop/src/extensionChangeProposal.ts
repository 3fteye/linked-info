import type {
  ExtensionChangeOperationV1,
  ExtensionChangeProposalV1,
  ExtensionProposalEndpointV1,
  ExtensionStringPatchV1,
  NodeHandle,
} from "./builtinExtensionHost";
import {
  normalizeNodeName,
  parseWorkspaceSnapshot,
  persistedNodeNameFromDraft,
  type InformationNode,
  type NodeReference,
  type WorkspaceSnapshot,
} from "./workspaceData";

const maximumProposalOperations = 256;
const maximumTemporaryIdBytes = 64;
const maximumNodeNameBytes = 64 * 1024;
const maximumNodeContentBytes = 1024 * 1024;
const temporaryIdPattern = /^[A-Za-z0-9_-]+$/;
const utf8Encoder = new TextEncoder();

export type ExtensionChangeProposalFailure =
  | "current-node-missing"
  | "duplicate-name"
  | "invalid-endpoint"
  | "invalid-operation"
  | "invalid-result"
  | "stale-revision";

export class ExtensionChangeProposalError extends Error {
  constructor(readonly reason: ExtensionChangeProposalFailure) {
    super(reason);
    this.name = "ExtensionChangeProposalError";
  }
}

export interface ExtensionChangeProposalContext {
  baseRevision: number;
  currentNodeId: string;
  handleNodeIds: ReadonlyMap<NodeHandle, string>;
  createNodeId?: () => string;
}

export interface PreparedExtensionChangeProposal {
  baseRevision: number;
  createdNodeIds: string[];
  workspace: WorkspaceSnapshot;
}

function fail(reason: ExtensionChangeProposalFailure): never {
  throw new ExtensionChangeProposalError(reason);
}

function validTemporaryId(value: string): boolean {
  return (
    value.length > 0 &&
    utf8Encoder.encode(value).byteLength <= maximumTemporaryIdBytes &&
    temporaryIdPattern.test(value)
  );
}

function boundedNodeText(name: string, content: string): boolean {
  return (
    utf8Encoder.encode(name).byteLength <= maximumNodeNameBytes &&
    utf8Encoder.encode(content).byteLength <= maximumNodeContentBytes
  );
}

function patchString(current: string | null, patch: ExtensionStringPatchV1): string {
  return patch.operation === "set" ? patch.value : (current ?? "");
}

function referenceKey(sourceNodeId: string, targetNodeId: string): string {
  return `${sourceNodeId}\0${targetNodeId}`;
}

function resolveEndpoint(
  endpoint: ExtensionProposalEndpointV1,
  existingNodeIds: ReadonlySet<string>,
  createdNodeIds: ReadonlyMap<string, string>,
  handleNodeIds: ReadonlyMap<NodeHandle, string>,
): string {
  if (endpoint.kind === "created") {
    return createdNodeIds.get(endpoint.temporaryId) ?? fail("invalid-endpoint");
  }
  const nodeId = handleNodeIds.get(endpoint.handle);
  return nodeId !== undefined && existingNodeIds.has(nodeId)
    ? nodeId
    : fail("invalid-endpoint");
}

function createReference(
  references: NodeReference[],
  sourceNodeId: string,
  targetNodeId: string,
): NodeReference[] {
  if (
    sourceNodeId === targetNodeId ||
    references.some(
      (reference) =>
        reference.sourceNodeId === sourceNodeId &&
        reference.targetNodeId === targetNodeId,
    )
  ) {
    fail("invalid-operation");
  }
  return [...references, { sourceNodeId, targetNodeId }];
}

function removeReference(
  references: NodeReference[],
  sourceNodeId: string,
  targetNodeId: string,
): NodeReference[] {
  const key = referenceKey(sourceNodeId, targetNodeId);
  const next = references.filter(
    (reference) => referenceKey(reference.sourceNodeId, reference.targetNodeId) !== key,
  );
  if (next.length === references.length) {
    fail("invalid-operation");
  }
  return next;
}

function applyStringPatch(
  node: InformationNode,
  operation: Extract<ExtensionChangeOperationV1, { type: "update-current-node" }>,
): InformationNode {
  const name = patchString(node.name, operation.name);
  const content = patchString(node.content, operation.content);
  if (!boundedNodeText(name, content)) {
    fail("invalid-operation");
  }
  return {
    ...node,
    name: persistedNodeNameFromDraft(name),
    content: content.length === 0 ? null : content,
  };
}

function validateUniqueNames(nodes: readonly InformationNode[]): void {
  const names = new Set<string>();
  for (const node of nodes) {
    const normalized = normalizeNodeName(node.name ?? "");
    if (normalized.length === 0) {
      continue;
    }
    if (names.has(normalized)) {
      fail("duplicate-name");
    }
    names.add(normalized);
  }
}

function createdNodePosition(
  workspace: WorkspaceSnapshot,
  currentNodeId: string,
  index: number,
): { x: number; y: number } {
  const anchor = workspace.layout.find((layout) => layout.nodeId === currentNodeId) ?? {
    x: 80,
    y: 80,
  };
  return {
    x: anchor.x + 320 + (index % 3) * 300,
    y: anchor.y + Math.floor(index / 3) * 210,
  };
}

export function prepareExtensionChangeProposal(
  workspace: WorkspaceSnapshot,
  proposal: ExtensionChangeProposalV1,
  context: ExtensionChangeProposalContext,
): PreparedExtensionChangeProposal {
  if (
    !Number.isSafeInteger(context.baseRevision) ||
    context.baseRevision < 0 ||
    proposal.baseRevision !== context.baseRevision
  ) {
    fail("stale-revision");
  }
  if (
    proposal.operations.length === 0 ||
    proposal.operations.length > maximumProposalOperations ||
    !workspace.nodes.some((node) => node.id === context.currentNodeId)
  ) {
    fail(
      workspace.nodes.some((node) => node.id === context.currentNodeId)
        ? "invalid-operation"
        : "current-node-missing",
    );
  }

  const existingNodeIds = new Set(workspace.nodes.map((node) => node.id));
  const createdNodeIds = new Map<string, string>();
  const createNodeId = context.createNodeId ?? (() => crypto.randomUUID());
  const createOperations = proposal.operations.filter(
    (operation): operation is Extract<ExtensionChangeOperationV1, { type: "create-node" }> =>
      operation.type === "create-node",
  );
  for (const operation of createOperations) {
    if (
      !validTemporaryId(operation.temporaryId) ||
      createdNodeIds.has(operation.temporaryId) ||
      !boundedNodeText(operation.name, operation.content)
    ) {
      fail("invalid-operation");
    }
    const nodeId = createNodeId();
    if (existingNodeIds.has(nodeId) || [...createdNodeIds.values()].includes(nodeId)) {
      fail("invalid-result");
    }
    createdNodeIds.set(operation.temporaryId, nodeId);
  }

  let nodes: InformationNode[] = [
    ...workspace.nodes,
    ...createOperations.map((operation) => ({
      id: createdNodeIds.get(operation.temporaryId)!,
      name: persistedNodeNameFromDraft(operation.name),
      content: operation.content.length === 0 ? null : operation.content,
    })),
  ];
  const layout = [
    ...workspace.layout,
    ...createOperations.map((operation, index) => ({
      nodeId: createdNodeIds.get(operation.temporaryId)!,
      ...createdNodePosition(workspace, context.currentNodeId, index),
    })),
  ];
  let references = workspace.references;

  for (const operation of proposal.operations) {
    if (operation.type === "create-node") {
      continue;
    }
    if (operation.type === "update-current-node") {
      nodes = nodes.map((node) =>
        node.id === context.currentNodeId ? applyStringPatch(node, operation) : node,
      );
      continue;
    }
    const sourceNodeId = resolveEndpoint(
      operation.source,
      existingNodeIds,
      createdNodeIds,
      context.handleNodeIds,
    );
    const targetNodeId = resolveEndpoint(
      operation.target,
      existingNodeIds,
      createdNodeIds,
      context.handleNodeIds,
    );
    references =
      operation.type === "create-reference"
        ? createReference(references, sourceNodeId, targetNodeId)
        : removeReference(references, sourceNodeId, targetNodeId);
  }

  validateUniqueNames(nodes);
  const candidate: WorkspaceSnapshot = {
    ...workspace,
    nodes,
    layout,
    references,
  };
  const validated = parseWorkspaceSnapshot(candidate);
  if (validated === null) {
    fail("invalid-result");
  }
  return {
    baseRevision: context.baseRevision,
    createdNodeIds: createOperations.map(
      (operation) => createdNodeIds.get(operation.temporaryId)!,
    ),
    workspace: validated,
  };
}

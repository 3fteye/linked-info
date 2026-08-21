import { invoke } from "@tauri-apps/api/core";
import type {
  BuiltInExtensionActionHostResult,
  BuiltInExtensionMetadataInput,
  BuiltInExtensionRenderResult,
  ExtensionChangeOperationV1,
  ExtensionChangeProposalV1,
  ExtensionPresentationV1,
  ExtensionProposalEndpointV1,
} from "./builtinExtensionHost";
import type { InstalledExtension } from "./extensionManager";
import type {
  ExtensionMetadataPayload,
  WorkspaceSnapshot,
} from "./workspaceStore";

export interface ManagedExtensionProcessorRegistration {
  extensionId: string;
  fullId: string;
  labelKey: string;
  localId: string;
  metadataSchemaVersion: number;
}

export interface ManagedExtensionNodeInput {
  id: string;
  name: string | null;
  content: string | null;
  directOutgoingNodeIds: string[];
  directIncomingNodeIds: string[];
}

export function managedExtensionNodeInputForWorkspace(
  workspace: WorkspaceSnapshot,
  nodeId: string,
): ManagedExtensionNodeInput | null {
  const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
  return node === undefined
    ? null
    : {
        id: node.id,
        name: node.name,
        content: node.content,
        directOutgoingNodeIds: workspace.references
          .filter((reference) => reference.sourceNodeId === nodeId)
          .map((reference) => reference.targetNodeId),
        directIncomingNodeIds: workspace.references
          .filter((reference) => reference.targetNodeId === nodeId)
          .map((reference) => reference.sourceNodeId),
      };
}

interface ManagedExtensionRenderWireResult {
  extensionId: string;
  metadataSchemaVersion: number;
  inputTruncated: boolean;
  presentation: ExtensionPresentationV1;
}

type WireProposalEndpoint =
  | { kind: "existing"; handle: number }
  | { kind: "created"; temporaryId: string };

type WireChangeOperation =
  | Exclude<
      ExtensionChangeOperationV1,
      { type: "create-reference" | "remove-reference" }
    >
  | {
      type: "create-reference" | "remove-reference";
      source: WireProposalEndpoint;
      target: WireProposalEndpoint;
    };

interface WireChangeProposal {
  baseRevision: number;
  titleKey: string;
  operations: WireChangeOperation[];
}

interface ManagedExtensionActionWireResult {
  extensionId: string;
  metadataSchemaVersion: number;
  handleNodeIds: Record<string, string>;
  result: {
    presentation: ExtensionPresentationV1 | null;
    nodeMetadata: unknown;
    workspaceMetadata: unknown;
    proposal: WireChangeProposal | null;
  };
}

function fullContributionId(extensionId: string, localId: string): string {
  return `${extensionId}.${localId}`;
}

function localeCandidates(language: string, fallback: string | null): string[] {
  const base = language.split("-")[0];
  return [...new Set([language, base, fallback].filter((value): value is string => Boolean(value)))];
}

class ManagedExtensionRegistry {
  private extensions = new Map<string, InstalledExtension>();
  private processors = new Map<string, ManagedExtensionProcessorRegistration>();

  replace(installed: readonly InstalledExtension[]): void {
    const extensions = new Map<string, InstalledExtension>();
    const processors = new Map<string, ManagedExtensionProcessorRegistration>();
    for (const extension of installed) {
      if (!extension.enabled || !extension.valid) continue;
      extensions.set(extension.id, extension);
      for (const processor of extension.processors) {
        const fullId = fullContributionId(extension.id, processor.id);
        if (processors.has(fullId)) {
          throw new Error(`duplicate managed extension processor: ${fullId}`);
        }
        processors.set(fullId, {
          extensionId: extension.id,
          fullId,
          labelKey: processor.labelKey,
          localId: processor.id,
          metadataSchemaVersion: extension.metadataSchemaVersion,
        });
      }
    }
    this.extensions = extensions;
    this.processors = processors;
  }

  listProcessors(): ManagedExtensionProcessorRegistration[] {
    return [...this.processors.values()];
  }

  processor(processorId: string | null): ManagedExtensionProcessorRegistration | null {
    return processorId === null ? null : (this.processors.get(processorId) ?? null);
  }

  resolveLabel(extensionId: string, key: string, language: string): string | null {
    const extension = this.extensions.get(extensionId);
    if (extension === undefined) return null;
    for (const locale of localeCandidates(language, extension.defaultLocale)) {
      const value = extension.locales[locale]?.[key];
      if (value !== undefined) return value;
    }
    return null;
  }

  actionLabelKey(extensionId: string, actionId: string): string | null {
    return (
      this.extensions
        .get(extensionId)
        ?.actions.find((action) => action.id === actionId)?.labelKey ?? null
    );
  }
}

export const managedExtensionRegistry = new ManagedExtensionRegistry();

function metadataForInvoke(
  metadata: BuiltInExtensionMetadataInput | null,
): BuiltInExtensionMetadataInput | null {
  return metadata;
}

export async function renderManagedExtensionProcessor(
  registration: ManagedExtensionProcessorRegistration,
  node: ManagedExtensionNodeInput,
  metadata: BuiltInExtensionMetadataInput | null,
): Promise<BuiltInExtensionRenderResult> {
  return invoke<ManagedExtensionRenderWireResult>(
    "render_managed_extension_processor",
    {
      extensionId: registration.extensionId,
      processorId: registration.localId,
      node,
      metadata: metadataForInvoke(metadata),
    },
  );
}

function proposalEndpoint(endpoint: WireProposalEndpoint): ExtensionProposalEndpointV1 {
  return endpoint.kind === "existing"
    ? { kind: "existing", handle: BigInt(endpoint.handle) }
    : endpoint;
}

function proposalOperation(operation: WireChangeOperation): ExtensionChangeOperationV1 {
  if (
    operation.type !== "create-reference" &&
    operation.type !== "remove-reference"
  ) {
    return operation as ExtensionChangeOperationV1;
  }
  return {
    ...operation,
    source: proposalEndpoint(operation.source),
    target: proposalEndpoint(operation.target),
  };
}

function proposal(value: WireChangeProposal | null): ExtensionChangeProposalV1 | null {
  return value === null
    ? null
    : {
        ...value,
        operations: value.operations.map(proposalOperation),
      };
}

function metadataPayload(
  value: unknown,
): ExtensionMetadataPayload | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ExtensionMetadataPayload)
    : null;
}

export async function invokeManagedExtensionAction(
  extensionId: string,
  actionId: string,
  nodes: ManagedExtensionNodeInput[],
  metadata: BuiltInExtensionMetadataInput | null,
  inputValue: string | null,
  baseRevision: number,
): Promise<BuiltInExtensionActionHostResult> {
  const wire = await invoke<ManagedExtensionActionWireResult>(
    "invoke_managed_extension_action",
    {
      extensionId,
      actionId,
      nodes,
      metadata: metadataForInvoke(metadata),
      inputValue,
      baseRevision,
    },
  );
  return {
    extensionId: wire.extensionId,
    handleNodeIds: new Map(
      Object.entries(wire.handleNodeIds).map(([handle, nodeId]) => [
        BigInt(handle),
        nodeId,
      ]),
    ),
    metadataSchemaVersion: wire.metadataSchemaVersion,
    nodeMetadata: metadataPayload(wire.result.nodeMetadata),
    presentation: wire.result.presentation,
    proposal: proposal(wire.result.proposal),
    workspaceMetadata: metadataPayload(wire.result.workspaceMetadata),
  };
}

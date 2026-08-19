import { contentForExtensionSnapshot } from "./contentEnhancer";
import type { ExtensionMetadataPayload } from "./workspaceData";

export type ExtensionCapability =
  | "node.read.name"
  | "node.read.content"
  | "graph.read.direct"
  | "metadata.node.read"
  | "metadata.node.write"
  | "metadata.workspace.read"
  | "metadata.workspace.write"
  | "workspace.propose"
  | "clock.monotonic";

export type NodeHandle = bigint;

export interface NodeSnapshotV1 {
  handle: NodeHandle;
  name: string | null;
  content: string | null;
  directOutgoing: NodeHandle[];
  directIncoming: NodeHandle[];
}

export type ExtensionPresentationElementV1 =
  | { type: "text"; text: string }
  | { type: "code"; language: string; source: string }
  | { type: "key-value"; items: Array<{ key: string; value: string }> }
  | { type: "table"; columns: string[]; rows: string[][] }
  | {
      type: "badge";
      text: string;
      tone: "neutral" | "positive" | "warning" | "critical";
    }
  | { type: "divider" }
  | { type: "button"; actionId: string }
  | {
      type: "select";
      actionId: string;
      labelKey: string;
      selected: string | null;
      options: Array<{ value: string; labelKey: string }>;
    };

export interface ExtensionPresentationV1 {
  elements: ExtensionPresentationElementV1[];
}

export interface ExtensionRenderRequestV1 {
  processorId: string;
  node: NodeSnapshotV1;
  nodeMetadataJson: string | null;
  workspaceMetadataJson: string | null;
  monotonicTimeMs: number | null;
}

export interface ExtensionActionRequestV1 {
  actionId: string;
  nodes: NodeSnapshotV1[];
  nodeMetadataJson: string | null;
  workspaceMetadataJson: string | null;
  inputValue: string | null;
  monotonicTimeMs: number | null;
  baseRevision: number;
}

export type ExtensionProposalEndpointV1 =
  | { kind: "existing"; handle: NodeHandle }
  | { kind: "created"; temporaryId: string };

export type ExtensionStringPatchV1 =
  | { operation: "unchanged" }
  | { operation: "set"; value: string };

export type ExtensionChangeOperationV1 =
  | {
      type: "create-node";
      temporaryId: string;
      name: string;
      content: string;
    }
  | {
      type: "update-current-node";
      name: ExtensionStringPatchV1;
      content: ExtensionStringPatchV1;
    }
  | {
      type: "create-reference" | "remove-reference";
      source: ExtensionProposalEndpointV1;
      target: ExtensionProposalEndpointV1;
    };

export interface ExtensionChangeProposalV1 {
  baseRevision: number;
  titleKey: string;
  operations: ExtensionChangeOperationV1[];
}

export interface ExtensionActionResultV1 {
  presentation: ExtensionPresentationV1 | null;
  nodeMetadataJson: string | null;
  workspaceMetadataJson: string | null;
  proposal: ExtensionChangeProposalV1 | null;
}

export interface BuiltInExtensionManifest {
  id: string;
  metadataSchemaVersion: number;
  capabilities: readonly ExtensionCapability[];
  processors: ReadonlyArray<{ id: string; labelKey: string }>;
  actions: ReadonlyArray<{ id: string; labelKey: string }>;
  localizationKeys: ReadonlySet<string>;
}

export interface BuiltInNodeExtension {
  readonly manifest: BuiltInExtensionManifest;
  render(request: ExtensionRenderRequestV1): ExtensionPresentationV1;
  invoke(request: ExtensionActionRequestV1): ExtensionActionResultV1;
  parseNodeMetadata(value: unknown): ExtensionMetadataPayload | null;
  parseWorkspaceMetadata(value: unknown): ExtensionMetadataPayload | null;
}

export interface BuiltInExtensionNodeInput {
  content: string | null;
  directIncomingCount?: number;
  directOutgoingCount?: number;
  name: string | null;
}

export interface BuiltInExtensionMetadataInput {
  node: ExtensionMetadataPayload;
  schemaVersion: number;
  workspace: ExtensionMetadataPayload;
}

export interface BuiltInExtensionRenderResult {
  extensionId: string;
  inputTruncated: boolean;
  metadataSchemaVersion: number;
  presentation: ExtensionPresentationV1;
}

export interface BuiltInExtensionActionHostResult {
  extensionId: string;
  metadataSchemaVersion: number;
  nodeMetadata: ExtensionMetadataPayload | null;
  presentation: ExtensionPresentationV1 | null;
  workspaceMetadata: ExtensionMetadataPayload | null;
}

interface RegisteredProcessor {
  extension: BuiltInNodeExtension;
  localId: string;
}

const maximumPassiveCharacters = 20_000;
const maximumPassiveLines = 500;
const maximumPresentationElements = 128;
const maximumPresentationStringCharacters = 20_000;
const maximumPresentationBytes = 1024 * 1024;
const presentationUtf8Encoder = new TextEncoder();
const extensionIdPattern =
  /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z](?:[a-z0-9-]*[a-z0-9])?){2,}$/;
const localIdPattern = /^[a-z][a-z0-9-]{0,63}$/;

function fullContributionId(extensionId: string, localId: string): string {
  return `${extensionId}.${localId}`;
}

function boundedPassiveContent(content: string | null): {
  content: string | null;
  truncated: boolean;
} {
  const sanitized = contentForExtensionSnapshot(content);
  if (sanitized === null) {
    return { content: null, truncated: false };
  }
  let end = Math.min(sanitized.length, maximumPassiveCharacters);
  let newlineCount = 0;
  for (let index = 0; index < end; index += 1) {
    if (sanitized[index] === "\n") {
      newlineCount += 1;
      if (newlineCount >= maximumPassiveLines) {
        end = index;
        break;
      }
    }
  }
  return {
    content: sanitized.slice(0, end),
    truncated: end < sanitized.length,
  };
}

function relationHandles(count: number | undefined, first: bigint): NodeHandle[] {
  if (count === undefined || !Number.isSafeInteger(count) || count <= 0) {
    return [];
  }
  return Array.from({ length: Math.min(count, 10_000) }, (_, index) =>
    first + BigInt(index),
  );
}

function buildNodeSnapshot(
  node: BuiltInExtensionNodeInput,
  capabilities: ReadonlySet<ExtensionCapability>,
): { snapshot: NodeSnapshotV1; truncated: boolean } {
  const bounded = boundedPassiveContent(
    capabilities.has("node.read.content") ? node.content : null,
  );
  const outgoing = capabilities.has("graph.read.direct")
    ? relationHandles(node.directOutgoingCount, 2n)
    : [];
  const incoming = capabilities.has("graph.read.direct")
    ? relationHandles(node.directIncomingCount, 2n + BigInt(outgoing.length))
    : [];
  return {
    snapshot: {
      handle: 1n,
      name: capabilities.has("node.read.name") ? node.name : null,
      content: bounded.content,
      directOutgoing: outgoing,
      directIncoming: incoming,
    },
    truncated: bounded.truncated,
  };
}

function parseMetadataJson(
  raw: string | null,
  parser: (value: unknown) => ExtensionMetadataPayload | null,
): ExtensionMetadataPayload | null {
  if (raw === null) {
    return null;
  }
  try {
    return parser(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function validPresentationString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    [...value].length <= maximumPresentationStringCharacters
  );
}

function validatePresentation(
  presentation: ExtensionPresentationV1,
  manifest: BuiltInExtensionManifest,
): ExtensionPresentationV1 {
  if (
    !Array.isArray(presentation.elements) ||
    presentation.elements.length > maximumPresentationElements ||
    presentationUtf8Encoder.encode(JSON.stringify(presentation)).byteLength >
      maximumPresentationBytes
  ) {
    throw new Error("built-in extension returned an invalid presentation");
  }
  const actionIds = new Set(manifest.actions.map((action) => action.id));
  for (const element of presentation.elements) {
    if (element.type === "text") {
      if (!validPresentationString(element.text)) {
        throw new Error("built-in extension returned invalid text");
      }
      continue;
    }
    if (element.type === "code") {
      if (
        !validPresentationString(element.language) ||
        !validPresentationString(element.source)
      ) {
        throw new Error("built-in extension returned invalid code");
      }
      continue;
    }
    if (element.type === "key-value") {
      if (
        element.items.length > 128 ||
        element.items.some(
          (item) =>
            !validPresentationString(item.key) ||
            !validPresentationString(item.value),
        )
      ) {
        throw new Error("built-in extension returned invalid key-value data");
      }
      continue;
    }
    if (element.type === "table") {
      if (
        element.columns.length > 128 ||
        element.rows.length > 1_024 ||
        element.columns.some((column) => !validPresentationString(column)) ||
        element.rows.some(
          (row) =>
            row.length !== element.columns.length ||
            row.some((cell) => !validPresentationString(cell)),
        )
      ) {
        throw new Error("built-in extension returned an invalid table");
      }
      continue;
    }
    if (element.type === "badge") {
      if (!validPresentationString(element.text)) {
        throw new Error("built-in extension returned an invalid badge");
      }
      continue;
    }
    if (element.type === "divider") {
      continue;
    }
    if (!actionIds.has(element.actionId)) {
      throw new Error("built-in extension returned an undeclared action");
    }
    if (element.type === "select") {
      const optionValues = new Set(element.options.map((option) => option.value));
      if (
        !manifest.localizationKeys.has(element.labelKey) ||
        element.options.length > 128 ||
        optionValues.size !== element.options.length ||
        (element.selected !== null && !optionValues.has(element.selected)) ||
        element.options.some(
          (option) =>
            !validPresentationString(option.value) ||
            !manifest.localizationKeys.has(option.labelKey),
        )
      ) {
        throw new Error("built-in extension returned an invalid select");
      }
    }
  }
  return presentation;
}

export class BuiltInExtensionHost {
  private readonly extensions: ReadonlyMap<string, BuiltInNodeExtension>;
  private readonly processors: ReadonlyMap<string, RegisteredProcessor>;

  constructor(extensions: readonly BuiltInNodeExtension[]) {
    const byId = new Map<string, BuiltInNodeExtension>();
    const processors = new Map<string, RegisteredProcessor>();
    for (const extension of extensions) {
      const { manifest } = extension;
      if (
        !extensionIdPattern.test(manifest.id) ||
        byId.has(manifest.id) ||
        !Number.isInteger(manifest.metadataSchemaVersion) ||
        manifest.metadataSchemaVersion <= 0
      ) {
        throw new Error("invalid or duplicate built-in extension manifest");
      }
      const localIds = new Set<string>();
      for (const contribution of [
        ...manifest.processors,
        ...manifest.actions,
      ]) {
        if (!localIdPattern.test(contribution.id) || localIds.has(contribution.id)) {
          throw new Error("invalid or duplicate built-in extension contribution");
        }
        if (!manifest.localizationKeys.has(contribution.labelKey)) {
          throw new Error("built-in extension contribution label is missing");
        }
        localIds.add(contribution.id);
      }
      byId.set(manifest.id, extension);
      for (const processor of manifest.processors) {
        const fullId = fullContributionId(manifest.id, processor.id);
        if (processors.has(fullId)) {
          throw new Error("duplicate built-in extension processor");
        }
        processors.set(fullId, { extension, localId: processor.id });
      }
    }
    this.extensions = byId;
    this.processors = processors;
  }

  listProcessors(): Array<{
    extensionId: string;
    id: string;
    labelKey: string;
    localId: string;
    metadataSchemaVersion: number;
  }> {
    return [...this.processors.entries()].map(([id, registration]) => ({
      extensionId: registration.extension.manifest.id,
      id,
      labelKey: registration.extension.manifest.processors.find(
        (processor) => processor.id === registration.localId,
      )!.labelKey,
      localId: registration.localId,
      metadataSchemaVersion:
        registration.extension.manifest.metadataSchemaVersion,
    }));
  }

  hasProcessor(processorId: string): boolean {
    return this.processors.has(processorId);
  }

  processorExtensionId(processorId: string): string | null {
    return this.processors.get(processorId)?.extension.manifest.id ?? null;
  }

  actionLabelKey(extensionId: string, actionId: string): string | null {
    return (
      this.extensions
        .get(extensionId)
        ?.manifest.actions.find((action) => action.id === actionId)?.labelKey ??
      null
    );
  }

  renderProcessor(
    processorId: string,
    node: BuiltInExtensionNodeInput,
    metadata: BuiltInExtensionMetadataInput | null,
  ): BuiltInExtensionRenderResult {
    const registration = this.processors.get(processorId);
    if (registration === undefined) {
      throw new Error("unknown built-in extension processor");
    }
    const { extension, localId } = registration;
    const { manifest } = extension;
    const capabilities = new Set(manifest.capabilities);
    const invocationNode = buildNodeSnapshot(node, capabilities);
    const metadataMatches =
      metadata?.schemaVersion === manifest.metadataSchemaVersion;
    const presentation = extension.render({
      processorId: localId,
      node: invocationNode.snapshot,
      nodeMetadataJson:
        metadataMatches && capabilities.has("metadata.node.read")
          ? JSON.stringify(metadata.node)
          : null,
      workspaceMetadataJson:
        metadataMatches && capabilities.has("metadata.workspace.read")
          ? JSON.stringify(metadata.workspace)
          : null,
      monotonicTimeMs: capabilities.has("clock.monotonic")
        ? performance.now()
        : null,
    });
    return {
      extensionId: manifest.id,
      inputTruncated: invocationNode.truncated,
      metadataSchemaVersion: manifest.metadataSchemaVersion,
      presentation: validatePresentation(presentation, manifest),
    };
  }

  invokeAction(
    extensionId: string,
    actionId: string,
    node: BuiltInExtensionNodeInput,
    metadata: BuiltInExtensionMetadataInput | null,
    inputValue: string | null,
    baseRevision = 0,
  ): BuiltInExtensionActionHostResult {
    const extension = this.extensions.get(extensionId);
    if (extension === undefined) {
      throw new Error("unknown built-in extension");
    }
    const { manifest } = extension;
    if (!manifest.actions.some((action) => action.id === actionId)) {
      throw new Error("unknown built-in extension action");
    }
    const capabilities = new Set(manifest.capabilities);
    const invocationNode = buildNodeSnapshot(node, capabilities);
    const metadataMatches =
      metadata?.schemaVersion === manifest.metadataSchemaVersion;
    const result = extension.invoke({
      actionId,
      nodes: [invocationNode.snapshot],
      nodeMetadataJson:
        metadataMatches && capabilities.has("metadata.node.read")
          ? JSON.stringify(metadata.node)
          : null,
      workspaceMetadataJson:
        metadataMatches && capabilities.has("metadata.workspace.read")
          ? JSON.stringify(metadata.workspace)
          : null,
      inputValue,
      monotonicTimeMs: capabilities.has("clock.monotonic")
        ? performance.now()
        : null,
      baseRevision,
    });
    if (result.proposal !== null) {
      throw new Error("built-in adapter cannot apply workspace proposals yet");
    }
    const nodeMetadata = parseMetadataJson(
      result.nodeMetadataJson,
      (value) => extension.parseNodeMetadata(value),
    );
    const workspaceMetadata = parseMetadataJson(
      result.workspaceMetadataJson,
      (value) => extension.parseWorkspaceMetadata(value),
    );
    if (
      (result.nodeMetadataJson !== null &&
        (!capabilities.has("metadata.node.write") || nodeMetadata === null)) ||
      (result.workspaceMetadataJson !== null &&
        (!capabilities.has("metadata.workspace.write") ||
          workspaceMetadata === null))
    ) {
      throw new Error("built-in extension returned invalid metadata");
    }
    return {
      extensionId,
      metadataSchemaVersion: manifest.metadataSchemaVersion,
      nodeMetadata,
      presentation:
        result.presentation === null
          ? null
          : validatePresentation(result.presentation, manifest),
      workspaceMetadata,
    };
  }
}

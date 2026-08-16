import { invoke } from "@tauri-apps/api/core";
import { nodeEmbeddingText } from "./embeddingService";
import { embeddingSettingsFingerprint, type EmbeddingSettings } from "./embeddingSettings";
import type { EmbeddingCandidate, EmbeddingRelatedNode } from "./embeddingService";
import type { LlmSettings } from "./llmSettings";
import type { WorkspaceSnapshot } from "./workspaceData";

const resultAlgorithmVersion = "smart-reference-result-v1";
const maximumCandidates = 256;
const maximumRelatedNodes = 256;
const maximumSupportingNodes = 32;

export interface CachedSmartReferenceResult {
  candidates: EmbeddingCandidate[];
  generatedAtMs: number;
  llmEnabled: boolean;
  llmNoMatch: boolean;
  llmSelectedNodeIds: string[];
  llmUncertainNodeIds: string[];
  relatedNodes: EmbeddingRelatedNode[];
  sourceNodeId: string;
  truncatedNodeCount: number;
}

export interface SmartReferenceResultCacheStatus {
  diskBytes: number;
  entryCount: number;
  maxBytes: number;
  persistent: boolean;
}

export interface SmartReferenceResultCache {
  clear(): Promise<SmartReferenceResultCacheStatus>;
  inspect(): Promise<SmartReferenceResultCacheStatus>;
  read(key: string): Promise<CachedSmartReferenceResult | null>;
  write(key: string, result: CachedSmartReferenceResult): Promise<void>;
}

function validNodeId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

function validNodeIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumCandidates &&
    value.every(validNodeId) &&
    new Set(value).size === value.length
  );
}

function validCandidate(value: unknown): value is EmbeddingCandidate {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<EmbeddingCandidate>;
  return (
    validNodeId(candidate.nodeId) &&
    typeof candidate.score === "number" &&
    Number.isFinite(candidate.score) &&
    candidate.score >= 0 &&
    candidate.score <= 1 &&
    Array.isArray(candidate.supportingNodeIds) &&
    candidate.supportingNodeIds.length <= maximumSupportingNodes &&
    candidate.supportingNodeIds.every(validNodeId) &&
    new Set(candidate.supportingNodeIds).size === candidate.supportingNodeIds.length
  );
}

function validRelatedNode(value: unknown): value is EmbeddingRelatedNode {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const related = value as Partial<EmbeddingRelatedNode>;
  return (
    validNodeId(related.nodeId) &&
    typeof related.similarity === "number" &&
    Number.isFinite(related.similarity) &&
    related.similarity >= -1 &&
    related.similarity <= 1
  );
}

export function parseCachedSmartReferenceResult(
  value: unknown,
): CachedSmartReferenceResult | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const result = value as Partial<CachedSmartReferenceResult>;
  if (
    !validNodeId(result.sourceNodeId) ||
    typeof result.generatedAtMs !== "number" ||
    !Number.isSafeInteger(result.generatedAtMs) ||
    result.generatedAtMs < 0 ||
    typeof result.llmEnabled !== "boolean" ||
    typeof result.llmNoMatch !== "boolean" ||
    !validNodeIdList(result.llmSelectedNodeIds) ||
    !validNodeIdList(result.llmUncertainNodeIds) ||
    result.llmSelectedNodeIds.some((id) => result.llmUncertainNodeIds!.includes(id)) ||
    !Array.isArray(result.candidates) ||
    result.candidates.length > maximumCandidates ||
    !result.candidates.every(validCandidate) ||
    !Array.isArray(result.relatedNodes) ||
    result.relatedNodes.length > maximumRelatedNodes ||
    !result.relatedNodes.every(validRelatedNode) ||
    typeof result.truncatedNodeCount !== "number" ||
    !Number.isSafeInteger(result.truncatedNodeCount) ||
    result.truncatedNodeCount < 0
  ) {
    return null;
  }
  return result as CachedSmartReferenceResult;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return bytesToHex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

export function smartReferenceResultSettingsFingerprint(
  embeddingSettings: EmbeddingSettings,
  llmSettings: LlmSettings,
): string {
  return JSON.stringify([
    embeddingSettingsFingerprint(embeddingSettings),
    llmSettings.enabled ? ["local", llmSettings.localModel] : ["disabled"],
    llmSettings.enabled
      ? ["threshold-auto-reference-paused"]
      : [
          "threshold-auto-reference",
          embeddingSettings.autoReferenceEnabled,
          embeddingSettings.autoReferenceThreshold,
          embeddingSettings.thresholdFingerprint,
        ],
  ]);
}

export async function smartReferenceResultCacheKey(
  sourceNodeId: string,
  workspace: WorkspaceSnapshot,
  embeddingSettings: EmbeddingSettings,
  llmSettings: LlmSettings,
): Promise<string> {
  const nodes = workspace.nodes
    .map((node) => [node.id, nodeEmbeddingText(node)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const references = workspace.references
    .map((reference) => [reference.sourceNodeId, reference.targetNodeId] as const)
    .sort(([leftSource, leftTarget], [rightSource, rightTarget]) =>
      leftSource === rightSource
        ? leftTarget.localeCompare(rightTarget)
        : leftSource.localeCompare(rightSource),
    );
  return sha256(
    JSON.stringify([
      resultAlgorithmVersion,
      smartReferenceResultSettingsFingerprint(embeddingSettings, llmSettings),
      sourceNodeId,
      nodes,
      references,
    ]),
  );
}

export const tauriSmartReferenceResultCache: SmartReferenceResultCache = {
  clear() {
    return invoke<SmartReferenceResultCacheStatus>("clear_smart_reference_result_cache");
  },
  inspect() {
    return invoke<SmartReferenceResultCacheStatus>("inspect_smart_reference_result_cache");
  },
  async read(key) {
    const value = await invoke<unknown | null>("read_smart_reference_result_cache", { key });
    return value === null ? null : parseCachedSmartReferenceResult(value);
  },
  write(key, result) {
    return invoke<void>("write_smart_reference_result_cache", { key, result });
  },
};

const emptyStatus: SmartReferenceResultCacheStatus = {
  diskBytes: 0,
  entryCount: 0,
  maxBytes: 0,
  persistent: false,
};

export const memoryOnlySmartReferenceResultCache: SmartReferenceResultCache = {
  async clear() {
    return emptyStatus;
  },
  async inspect() {
    return emptyStatus;
  },
  async read() {
    return null;
  },
  async write() {},
};

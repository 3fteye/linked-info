import type { InformationNode, NodeReference } from "./workspaceStore";
import {
  embeddingSettingsFingerprint,
  type EmbeddingSettings,
} from "./embeddingSettings";
import type { LocalEmbeddingModelId } from "./localEmbeddingModels";
import {
  EmbeddingMemoryLru,
  unavailableEmbeddingVectorCache,
  type EmbeddingVectorCache,
  type EmbeddingVectorCacheEntry,
  type EmbeddingVectorCacheKey,
  type EmbeddingVectorRole,
} from "./embeddingCache";

export type EmbeddingInputRole = EmbeddingVectorRole;

export interface EmbeddingInput {
  role: EmbeddingInputRole;
  text: string;
}

export interface RemoteEmbeddingConfiguration {
  endpoint: string;
  model: string;
  token: string;
}

export interface EmbeddingGateway {
  embedLocal(
    modelId: LocalEmbeddingModelId,
    inputs: EmbeddingInput[],
  ): Promise<number[][]>;
  embedRemote(
    configuration: RemoteEmbeddingConfiguration,
    inputs: EmbeddingInput[],
  ): Promise<number[][]>;
}

export type EmbeddingAnalysisError =
  | "sourceEmpty"
  | "remoteConfigurationMissing"
  | "invalidEmbeddingResponse";

export class EmbeddingAnalysisFailure extends Error {
  readonly reason: EmbeddingAnalysisError;

  constructor(reason: EmbeddingAnalysisError) {
    super(reason);
    this.name = "EmbeddingAnalysisFailure";
    this.reason = reason;
  }
}

export interface EmbeddingCandidate {
  nodeId: string;
  score: number;
  supportingNodeIds: string[];
}

export interface EmbeddingRelatedNode {
  nodeId: string;
  similarity: number;
}

export interface EmbeddingAnalysis {
  candidates: EmbeddingCandidate[];
  relatedNodes: EmbeddingRelatedNode[];
  truncatedNodeCount: number;
}

interface NodeChunks {
  nodeId: string;
  chunks: string[];
  truncated: boolean;
}

const chunkLength = 360;
const chunkOverlap = 60;
const maximumChunksPerNode = 8;
const maximumEmbeddingBatchSize = 64;
const maximumPersistentCacheBatchSize = 256;
const maximumReferenceEvidenceNodes = 8;
const referenceEvidenceTemperature = 0.05;
const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256Text(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", textEncoder.encode(text));
  return bytesToHex(new Uint8Array(digest));
}

function memoryCacheKey(key: EmbeddingVectorCacheKey): string {
  return `${key.fingerprint}:${key.role}:${key.contentHash}`;
}

function validVector(vector: number[]): Float32Array | null {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const compact = Float32Array.from(vector);
  return compact.some((value) => !Number.isFinite(value)) ? null : compact;
}

export function nodeEmbeddingText(node: InformationNode): string | null {
  const name = node.name?.trim() ?? "";
  const content = node.content?.trim() ?? "";
  if (name.length === 0 && content.length === 0) {
    return null;
  }
  if (name.length === 0) {
    return content;
  }
  if (content.length === 0) {
    return name;
  }
  return `${name}\n${content}`;
}

export function chunkEmbeddingText(text: string): { chunks: string[]; truncated: boolean } {
  const characters = Array.from(text);
  if (characters.length <= chunkLength) {
    return { chunks: [text], truncated: false };
  }

  const normalStep = chunkLength - chunkOverlap;
  const normalChunkCount = Math.ceil((characters.length - chunkLength) / normalStep) + 1;
  if (normalChunkCount <= maximumChunksPerNode) {
    const chunks: string[] = [];
    for (let start = 0; start < characters.length; start += normalStep) {
      chunks.push(characters.slice(start, start + chunkLength).join(""));
      if (start + chunkLength >= characters.length) {
        break;
      }
    }
    return { chunks, truncated: false };
  }

  const lastStart = characters.length - chunkLength;
  const chunks = Array.from({ length: maximumChunksPerNode }, (_, index) => {
    const start = Math.round((lastStart * index) / (maximumChunksPerNode - 1));
    return characters.slice(start, start + chunkLength).join("");
  });
  return { chunks, truncated: true };
}

export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length === 0 || left.length !== right.length) {
    throw new EmbeddingAnalysisFailure("invalidEmbeddingResponse");
  }

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      throw new EmbeddingAnalysisFailure("invalidEmbeddingResponse");
    }
    dotProduct += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    throw new EmbeddingAnalysisFailure("invalidEmbeddingResponse");
  }
  return dotProduct / Math.sqrt(leftMagnitude * rightMagnitude);
}

function chunksForNode(node: InformationNode): NodeChunks | null {
  const text = nodeEmbeddingText(node);
  if (text === null) {
    return null;
  }
  const chunked = chunkEmbeddingText(text);
  return { nodeId: node.id, ...chunked };
}

export function propagateReferenceCandidates(
  sourceNodeId: string,
  relatedNodes: EmbeddingRelatedNode[],
  references: NodeReference[],
  validNodeIds: ReadonlySet<string>,
): EmbeddingCandidate[] {
  const outgoingTargets = new Map<string, Set<string>>();
  for (const reference of references) {
    if (!validNodeIds.has(reference.sourceNodeId) || !validNodeIds.has(reference.targetNodeId)) {
      continue;
    }
    const targets = outgoingTargets.get(reference.sourceNodeId) ?? new Set<string>();
    targets.add(reference.targetNodeId);
    outgoingTargets.set(reference.sourceNodeId, targets);
  }
  const existingTargets = outgoingTargets.get(sourceNodeId) ?? new Set<string>();
  const eligibleEvidence = relatedNodes
    .filter(
      (related) =>
        !existingTargets.has(related.nodeId) &&
        (outgoingTargets.get(related.nodeId)?.size ?? 0) > 0,
    );
  const seed = eligibleEvidence[0];
  if (seed === undefined) {
    return [];
  }

  const evidence = [seed];
  const evidenceTargets = new Set(outgoingTargets.get(seed.nodeId));
  for (const related of eligibleEvidence.slice(1)) {
    if (evidence.length >= maximumReferenceEvidenceNodes) {
      break;
    }
    const targets = outgoingTargets.get(related.nodeId) ?? new Set<string>();
    if (![...targets].some((targetNodeId) => evidenceTargets.has(targetNodeId))) {
      continue;
    }
    evidence.push(related);
    targets.forEach((targetNodeId) => evidenceTargets.add(targetNodeId));
  }

  const bestSimilarity = evidence[0].similarity;
  const weightedEvidence = evidence.map((related) => ({
    ...related,
    weight: Math.exp(
      (related.similarity - bestSimilarity) / referenceEvidenceTemperature,
    ),
  }));
  const totalWeight = weightedEvidence.reduce(
    (sum, related) => sum + related.weight,
    0,
  );
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    throw new EmbeddingAnalysisFailure("invalidEmbeddingResponse");
  }

  const votes = new Map<
    string,
    { supportingNodeIds: string[]; weight: number }
  >();
  for (const related of weightedEvidence) {
    for (const targetNodeId of outgoingTargets.get(related.nodeId) ?? []) {
      if (
        targetNodeId === sourceNodeId ||
        existingTargets.has(targetNodeId)
      ) {
        continue;
      }
      const vote = votes.get(targetNodeId) ?? {
        supportingNodeIds: [],
        weight: 0,
      };
      vote.weight += related.weight;
      vote.supportingNodeIds.push(related.nodeId);
      votes.set(targetNodeId, vote);
    }
  }

  const candidates = [...votes.entries()].map(([nodeId, vote]) => {
    const repeatedSupportReliability = Math.min(
      1,
      vote.supportingNodeIds.length / 2,
    );
    return {
      nodeId,
      score: Math.min(
        1,
        Math.max(0, (vote.weight / totalWeight) * repeatedSupportReliability),
      ),
      supportingNodeIds: vote.supportingNodeIds,
    };
  });
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      right.supportingNodeIds.length - left.supportingNodeIds.length ||
      left.nodeId.localeCompare(right.nodeId),
  );
  return candidates;
}

export class EmbeddingAnalyzer {
  private readonly memoryCache: EmbeddingMemoryLru;

  constructor(
    private readonly gateway: EmbeddingGateway,
    private readonly persistentCache: EmbeddingVectorCache =
      unavailableEmbeddingVectorCache,
    memoryCacheBytes?: number,
  ) {
    this.memoryCache = new EmbeddingMemoryLru(memoryCacheBytes);
  }

  async analyze(
    sourceNodeId: string,
    nodes: InformationNode[],
    references: NodeReference[],
    settings: EmbeddingSettings,
    remoteToken: string,
  ): Promise<EmbeddingAnalysis> {
    const sourceNode = nodes.find((node) => node.id === sourceNodeId);
    const source = sourceNode === undefined ? null : chunksForNode(sourceNode);
    if (source === null) {
      throw new EmbeddingAnalysisFailure("sourceEmpty");
    }

    const comparableNodes = nodes
      .filter((node) => node.id !== sourceNodeId)
      .map(chunksForNode)
      .filter((node): node is NodeChunks => node !== null);
    if (comparableNodes.length === 0) {
      return {
        candidates: [],
        relatedNodes: [],
        truncatedNodeCount: source.truncated ? 1 : 0,
      };
    }

    const sourceVectors = await this.embeddingsFor(
      source.chunks.map((text) => ({ role: "query" as const, text })),
      settings,
      remoteToken,
    );
    const documentInputs = comparableNodes.flatMap((node) =>
      node.chunks.map((text) => ({ role: "document" as const, text })),
    );
    const documentVectors = await this.embeddingsFor(
      documentInputs,
      settings,
      remoteToken,
    );

    let documentIndex = 0;
    const relatedNodes = comparableNodes.map<EmbeddingRelatedNode>((node) => {
      let bestScore = -1;
      for (let chunkIndex = 0; chunkIndex < node.chunks.length; chunkIndex += 1) {
        const documentVector = documentVectors[documentIndex];
        documentIndex += 1;
        for (const sourceVector of sourceVectors) {
          bestScore = Math.max(bestScore, cosineSimilarity(sourceVector, documentVector));
        }
      }
      return { nodeId: node.nodeId, similarity: bestScore };
    });

    relatedNodes.sort(
      (left, right) =>
        right.similarity - left.similarity ||
        left.nodeId.localeCompare(right.nodeId),
    );
    return {
      candidates: propagateReferenceCandidates(
        sourceNodeId,
        relatedNodes,
        references,
        new Set(nodes.map((node) => node.id)),
      ),
      relatedNodes,
      truncatedNodeCount:
        Number(source.truncated) +
        comparableNodes.filter((node) => node.truncated).length,
    };
  }

  clearCache(): void {
    this.memoryCache.clear();
  }

  private async embeddingsFor(
    inputs: EmbeddingInput[],
    settings: EmbeddingSettings,
    remoteToken: string,
  ): Promise<Float32Array[]> {
    const fingerprint = await sha256Text(embeddingSettingsFingerprint(settings));
    const hashes: string[] = [];
    for (let start = 0; start < inputs.length; start += maximumPersistentCacheBatchSize) {
      hashes.push(
        ...(await Promise.all(
          inputs
            .slice(start, start + maximumPersistentCacheBatchSize)
            .map((input) => sha256Text(input.text)),
        )),
      );
    }
    const persistentKeys = inputs.map<EmbeddingVectorCacheKey>((input, index) => ({
      fingerprint,
      role: input.role,
      contentHash: hashes[index],
    }));
    const cacheKeys = persistentKeys.map(memoryCacheKey);
    const resolvedVectors = new Array<Float32Array | undefined>(inputs.length);
    const indexesByCacheKey = new Map<string, number[]>();
    cacheKeys.forEach((key, index) => {
      const cached = this.memoryCache.get(key);
      if (cached !== undefined) {
        resolvedVectors[index] = cached;
        return;
      }
      const indexes = indexesByCacheKey.get(key) ?? [];
      indexes.push(index);
      indexesByCacheKey.set(key, indexes);
    });

    const uniqueMissing = [...indexesByCacheKey.entries()].map(([cacheKey, indexes]) => ({
      cacheKey,
      indexes,
      input: inputs[indexes[0]],
      persistentKey: persistentKeys[indexes[0]],
    }));
    for (let start = 0; start < uniqueMissing.length; start += maximumPersistentCacheBatchSize) {
      const batch = uniqueMissing.slice(start, start + maximumPersistentCacheBatchSize);
      let cachedVectors: Array<number[] | null> | null = null;
      try {
        const result = await this.persistentCache.read(
          batch.map((item) => item.persistentKey),
        );
        if (result.length === batch.length) {
          cachedVectors = result;
        }
      } catch {
        cachedVectors = null;
      }
      if (cachedVectors === null) {
        continue;
      }
      cachedVectors.forEach((vector, index) => {
        if (vector === null) {
          return;
        }
        const compact = validVector(vector);
        if (compact === null) {
          return;
        }
        const item = batch[index];
        this.memoryCache.set(item.cacheKey, compact);
        item.indexes.forEach((inputIndex) => {
          resolvedVectors[inputIndex] = compact;
        });
      });
    }

    const stillMissing = uniqueMissing.filter(({ indexes }) =>
      indexes.some((index) => resolvedVectors[index] === undefined),
    );
    if (stillMissing.length > 0) {
      for (let start = 0; start < stillMissing.length; start += maximumEmbeddingBatchSize) {
        const batch = stillMissing.slice(start, start + maximumEmbeddingBatchSize);
        const batchInputs = batch.map((item) => item.input);
        let responseVectors: number[][];
        if (settings.provider === "local") {
          responseVectors = await this.gateway.embedLocal(settings.localModel, batchInputs);
        } else {
          const endpoint = settings.remoteEndpoint.trim();
          const model = settings.remoteModel.trim();
          if (endpoint.length === 0 || model.length === 0) {
            throw new EmbeddingAnalysisFailure("remoteConfigurationMissing");
          }
          responseVectors = await this.gateway.embedRemote(
            { endpoint, model, token: remoteToken.trim() },
            batchInputs,
          );
        }
        if (responseVectors.length !== batchInputs.length) {
          throw new EmbeddingAnalysisFailure("invalidEmbeddingResponse");
        }
        const persistentEntries: EmbeddingVectorCacheEntry[] = [];
        responseVectors.forEach((vector, index) => {
          const compact = validVector(vector);
          if (compact === null) {
            throw new EmbeddingAnalysisFailure("invalidEmbeddingResponse");
          }
          const item = batch[index];
          this.memoryCache.set(item.cacheKey, compact);
          item.indexes.forEach((inputIndex) => {
            resolvedVectors[inputIndex] = compact;
          });
          persistentEntries.push({
            ...item.persistentKey,
            vector: Array.from(compact),
          });
        });
        try {
          await this.persistentCache.write(persistentEntries);
        } catch {
          // The cache is derived data. A write failure must not discard a valid analysis.
        }
      }
    }

    return resolvedVectors.map((vector) => {
      if (vector === undefined) {
        throw new EmbeddingAnalysisFailure("invalidEmbeddingResponse");
      }
      return vector;
    });
  }
}

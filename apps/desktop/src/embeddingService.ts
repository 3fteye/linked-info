import type { InformationNode, NodeReference } from "./workspaceStore";
import {
  embeddingSettingsFingerprint,
  type EmbeddingSettings,
} from "./embeddingSettings";

export type EmbeddingInputRole = "query" | "document";

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
  embedLocal(inputs: EmbeddingInput[]): Promise<number[][]>;
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
}

export interface EmbeddingAnalysis {
  candidates: EmbeddingCandidate[];
  truncatedNodeCount: number;
}

interface NodeChunks {
  nodeId: string;
  chunks: string[];
  truncated: boolean;
}

interface CachedEmbedding {
  vector: number[];
}

const chunkLength = 360;
const chunkOverlap = 60;
const maximumChunksPerNode = 8;
const maximumEmbeddingBatchSize = 64;

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

export function cosineSimilarity(left: number[], right: number[]): number {
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

export class EmbeddingAnalyzer {
  private readonly cache = new Map<string, CachedEmbedding>();

  constructor(private readonly gateway: EmbeddingGateway) {}

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

    const existingTargets = new Set(
      references
        .filter((reference) => reference.sourceNodeId === sourceNodeId)
        .map((reference) => reference.targetNodeId),
    );
    const candidates = nodes
      .filter((node) => node.id !== sourceNodeId && !existingTargets.has(node.id))
      .map(chunksForNode)
      .filter((node): node is NodeChunks => node !== null);
    if (candidates.length === 0) {
      return { candidates: [], truncatedNodeCount: source.truncated ? 1 : 0 };
    }

    const sourceVectors = await this.embeddingsFor(
      source.chunks.map((text) => ({ role: "query" as const, text })),
      settings,
      remoteToken,
    );
    const documentInputs = candidates.flatMap((candidate) =>
      candidate.chunks.map((text) => ({ role: "document" as const, text })),
    );
    const documentVectors = await this.embeddingsFor(
      documentInputs,
      settings,
      remoteToken,
    );

    let documentIndex = 0;
    const ranked = candidates.map((candidate) => {
      let bestScore = -1;
      for (let chunkIndex = 0; chunkIndex < candidate.chunks.length; chunkIndex += 1) {
        const documentVector = documentVectors[documentIndex];
        documentIndex += 1;
        for (const sourceVector of sourceVectors) {
          bestScore = Math.max(bestScore, cosineSimilarity(sourceVector, documentVector));
        }
      }
      return { nodeId: candidate.nodeId, score: bestScore };
    });

    ranked.sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId));
    return {
      candidates: ranked,
      truncatedNodeCount:
        Number(source.truncated) + candidates.filter((candidate) => candidate.truncated).length,
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async embeddingsFor(
    inputs: EmbeddingInput[],
    settings: EmbeddingSettings,
    remoteToken: string,
  ): Promise<number[][]> {
    const fingerprint = embeddingSettingsFingerprint(settings);
    const keys = inputs.map(
      (input) => `${fingerprint}:${input.role}:${input.text}`,
    );
    const missingInputs: EmbeddingInput[] = [];
    const missingKeys: string[] = [];
    keys.forEach((key, index) => {
      if (!this.cache.has(key)) {
        missingKeys.push(key);
        missingInputs.push(inputs[index]);
      }
    });

    if (missingInputs.length > 0) {
      for (let start = 0; start < missingInputs.length; start += maximumEmbeddingBatchSize) {
        const batchInputs = missingInputs.slice(start, start + maximumEmbeddingBatchSize);
        const batchKeys = missingKeys.slice(start, start + maximumEmbeddingBatchSize);
        let vectors: number[][];
        if (settings.provider === "local") {
          vectors = await this.gateway.embedLocal(batchInputs);
        } else {
          const endpoint = settings.remoteEndpoint.trim();
          const model = settings.remoteModel.trim();
          if (endpoint.length === 0 || model.length === 0) {
            throw new EmbeddingAnalysisFailure("remoteConfigurationMissing");
          }
          vectors = await this.gateway.embedRemote(
            { endpoint, model, token: remoteToken.trim() },
            batchInputs,
          );
        }
        if (vectors.length !== batchInputs.length) {
          throw new EmbeddingAnalysisFailure("invalidEmbeddingResponse");
        }
        vectors.forEach((vector, index) => {
          if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
            throw new EmbeddingAnalysisFailure("invalidEmbeddingResponse");
          }
          this.cache.set(batchKeys[index], { vector });
        });
      }
    }

    return keys.map((key) => {
      const cached = this.cache.get(key);
      if (cached === undefined) {
        throw new EmbeddingAnalysisFailure("invalidEmbeddingResponse");
      }
      return cached.vector;
    });
  }
}

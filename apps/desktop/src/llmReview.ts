import type {
  EmbeddingAnalysis,
  EmbeddingCandidate,
  EmbeddingRelatedNode,
} from "./embeddingService";
import type {
  InformationNode,
  NodeReference,
} from "./workspaceStore";
import type { LocalLlmModelId } from "./localLlmModels";

export interface LlmReviewNodeSummary {
  name: string | null;
  content: string | null;
}

export interface LlmReviewCandidateInput extends LlmReviewNodeSummary {
  alias: string;
  examples: LlmReviewNodeSummary[];
  graphScore: number | null;
  similarity: number | null;
}

export interface LlmReviewRequest {
  source: LlmReviewNodeSummary;
  existingReferences: LlmReviewNodeSummary[];
  candidates: LlmReviewCandidateInput[];
}

export interface LlmReviewResponse {
  selectedAliases: string[];
  uncertainAliases: string[];
  noMatch: boolean;
}

export interface LlmReviewDecision {
  selectedNodeIds: string[];
  uncertainNodeIds: string[];
  noMatch: boolean;
}

export interface PreparedLlmReview {
  aliasesToNodeIds: ReadonlyMap<string, string>;
  request: LlmReviewRequest;
}

export type LlmProviderConfiguration = {
  kind: "local";
  modelId: LocalLlmModelId;
};

export interface LlmGateway {
  review(
    configuration: LlmProviderConfiguration,
    request: LlmReviewRequest,
  ): Promise<LlmReviewResponse>;
}

const maximumGraphCandidates = 16;
const maximumCandidateCount = 24;
const maximumExamplesPerCandidate = 2;
const maximumExistingReferences = 12;
export const maximumEstimatedLlmRequestTokens = 3_000;

export function estimatedLlmReviewRequestTokens(request: LlmReviewRequest): number {
  let estimated = 0;
  for (const character of JSON.stringify(request)) {
    estimated += (character.codePointAt(0) ?? 0) <= 0x7f ? 0.25 : 1;
  }
  return Math.ceil(estimated);
}

function fitRequestToContextBudget(
  source: LlmReviewNodeSummary,
  existingReferences: LlmReviewNodeSummary[],
  candidates: LlmReviewCandidateInput[],
): LlmReviewRequest | null {
  const request: LlmReviewRequest = { source, existingReferences, candidates };
  while (estimatedLlmReviewRequestTokens(request) > maximumEstimatedLlmRequestTokens) {
    const candidateWithExample = [...request.candidates]
      .reverse()
      .find((candidate) => candidate.examples.length > 0);
    if (candidateWithExample !== undefined) {
      candidateWithExample.examples.pop();
      continue;
    }
    const candidateWithOptionalContent = [...request.candidates]
      .reverse()
      .find((candidate) => candidate.name !== null && candidate.content !== null);
    if (candidateWithOptionalContent !== undefined) {
      candidateWithOptionalContent.content = null;
      continue;
    }
    const referenceWithOptionalContent = [...request.existingReferences]
      .reverse()
      .find((reference) => reference.name !== null && reference.content !== null);
    if (referenceWithOptionalContent !== undefined) {
      referenceWithOptionalContent.content = null;
      continue;
    }
    if (request.existingReferences.length > 0) {
      request.existingReferences.pop();
      continue;
    }
    request.candidates.pop();
    if (request.candidates.length === 0) {
      return null;
    }
  }
  return request;
}

function boundedText(value: string | null, maximumCharacters: number): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  const characters = Array.from(trimmed);
  return characters.length <= maximumCharacters
    ? trimmed
    : `${characters.slice(0, maximumCharacters - 1).join("")}…`;
}

function summarizeNode(
  node: InformationNode,
  contentLimit: number,
): LlmReviewNodeSummary | null {
  const name = boundedText(node.name, 160);
  const content = boundedText(node.content, contentLimit);
  return name === null && content === null ? null : { name, content };
}

function candidateNodeIds(
  sourceNodeId: string,
  nodes: InformationNode[],
  references: NodeReference[],
  candidates: EmbeddingCandidate[],
  relatedNodes: EmbeddingRelatedNode[],
): string[] {
  const existingTargets = new Set(
    references
      .filter((reference) => reference.sourceNodeId === sourceNodeId)
      .map((reference) => reference.targetNodeId),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  const graphNodeIds = candidates
    .filter(
      (candidate) =>
        nodeIds.has(candidate.nodeId) &&
        candidate.nodeId !== sourceNodeId &&
        !existingTargets.has(candidate.nodeId),
    )
    .slice(0, maximumGraphCandidates)
    .map((candidate) => candidate.nodeId);
  const usedTargetIds = new Set(
    references
      .map((reference) => reference.targetNodeId)
      .filter(
        (nodeId) =>
          nodeIds.has(nodeId) &&
          nodeId !== sourceNodeId &&
          !existingTargets.has(nodeId),
      ),
  );
  const ordered = [...graphNodeIds];
  const selected = new Set(ordered);
  for (const related of relatedNodes) {
    if (ordered.length >= maximumCandidateCount) {
      break;
    }
    if (usedTargetIds.has(related.nodeId) && !selected.has(related.nodeId)) {
      selected.add(related.nodeId);
      ordered.push(related.nodeId);
    }
  }
  return ordered;
}

export function prepareLlmReview(
  sourceNodeId: string,
  nodes: InformationNode[],
  references: NodeReference[],
  analysis: EmbeddingAnalysis,
): PreparedLlmReview | null {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const source = nodesById.get(sourceNodeId);
  const sourceSummary = source === undefined ? null : summarizeNode(source, 1_600);
  if (sourceSummary === null) {
    return null;
  }

  const graphCandidates = new Map(
    analysis.candidates.map((candidate) => [candidate.nodeId, candidate]),
  );
  const similarities = new Map(
    analysis.relatedNodes.map((related) => [related.nodeId, related.similarity]),
  );
  const relatedRank = new Map(
    analysis.relatedNodes.map((related, index) => [related.nodeId, index]),
  );
  const outgoingSourcesByTarget = new Map<string, string[]>();
  for (const reference of references) {
    const sources = outgoingSourcesByTarget.get(reference.targetNodeId) ?? [];
    sources.push(reference.sourceNodeId);
    outgoingSourcesByTarget.set(reference.targetNodeId, sources);
  }

  const aliasesToNodeIds = new Map<string, string>();
  const candidates: LlmReviewCandidateInput[] = [];
  for (const nodeId of candidateNodeIds(
    sourceNodeId,
    nodes,
    references,
    analysis.candidates,
    analysis.relatedNodes,
  )) {
    const node = nodesById.get(nodeId);
    const summary = node === undefined ? null : summarizeNode(node, 320);
    if (summary === null) {
      continue;
    }
    const alias = `C${String(candidates.length + 1).padStart(2, "0")}`;
    const examples = (outgoingSourcesByTarget.get(nodeId) ?? [])
      .filter((exampleNodeId) => exampleNodeId !== sourceNodeId)
      .sort(
        (left, right) =>
          (relatedRank.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (relatedRank.get(right) ?? Number.MAX_SAFE_INTEGER),
      )
      .map((exampleNodeId) => nodesById.get(exampleNodeId))
      .filter((example): example is InformationNode => example !== undefined)
      .map((example) => summarizeNode(example, 220))
      .filter((example): example is LlmReviewNodeSummary => example !== null)
      .slice(0, maximumExamplesPerCandidate);
    const graphCandidate = graphCandidates.get(nodeId);
    candidates.push({
      alias,
      ...summary,
      examples,
      graphScore: graphCandidate?.score ?? null,
      similarity: similarities.get(nodeId) ?? null,
    });
    aliasesToNodeIds.set(alias, nodeId);
  }
  if (candidates.length === 0) {
    return null;
  }

  const existingReferences = references
    .filter((reference) => reference.sourceNodeId === sourceNodeId)
    .map((reference) => nodesById.get(reference.targetNodeId))
    .filter((node): node is InformationNode => node !== undefined)
    .map((node) => summarizeNode(node, 220))
    .filter((summary): summary is LlmReviewNodeSummary => summary !== null)
    .slice(0, maximumExistingReferences);

  const request = fitRequestToContextBudget(
    sourceSummary,
    existingReferences,
    candidates,
  );
  if (request === null) {
    return null;
  }
  const retainedAliases = new Set(request.candidates.map((candidate) => candidate.alias));
  for (const alias of aliasesToNodeIds.keys()) {
    if (!retainedAliases.has(alias)) {
      aliasesToNodeIds.delete(alias);
    }
  }

  return {
    aliasesToNodeIds,
    request,
  };
}

function uniqueAliases(aliases: unknown): aliases is string[] {
  return (
    Array.isArray(aliases) &&
    aliases.every((alias) => typeof alias === "string") &&
    new Set(aliases).size === aliases.length
  );
}

export function validateLlmReviewResponse(
  prepared: PreparedLlmReview,
  response: LlmReviewResponse,
): LlmReviewDecision {
  if (
    !uniqueAliases(response.selectedAliases) ||
    !uniqueAliases(response.uncertainAliases) ||
    typeof response.noMatch !== "boolean"
  ) {
    throw new Error("local LLM response has an invalid structure");
  }
  const allAliases = [...response.selectedAliases, ...response.uncertainAliases];
  if (
    new Set(allAliases).size !== allAliases.length ||
    allAliases.some((alias) => !prepared.aliasesToNodeIds.has(alias))
  ) {
    throw new Error("local LLM response contains an unknown or repeated candidate");
  }
  if (
    response.noMatch !== (allAliases.length === 0)
  ) {
    throw new Error("local LLM no-match result conflicts with its candidate selection");
  }
  return {
    selectedNodeIds: response.selectedAliases.map(
      (alias) => prepared.aliasesToNodeIds.get(alias)!,
    ),
    uncertainNodeIds: response.uncertainAliases.map(
      (alias) => prepared.aliasesToNodeIds.get(alias)!,
    ),
    noMatch: response.noMatch,
  };
}

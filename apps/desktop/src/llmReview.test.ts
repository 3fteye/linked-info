import { describe, expect, it } from "vitest";
import {
  estimatedLlmReviewRequestTokens,
  maximumEstimatedLlmRequestTokens,
  prepareLlmReview,
  validateLlmReviewResponse,
} from "./llmReview";
import type { EmbeddingAnalysis } from "./embeddingService";
import type { InformationNode, NodeReference } from "./workspaceStore";

function node(id: string, name: string, content: string | null = null): InformationNode {
  return { id, name, content };
}

const nodes = [
  node("source", "新账号"),
  node("account-a", "历史账号 A"),
  node("gmail", "Gmail"),
  node("openai", "OpenAI"),
  node("unused-tag", "尚未使用的标签"),
];

const references: NodeReference[] = [
  { sourceNodeId: "account-a", targetNodeId: "gmail" },
  { sourceNodeId: "account-a", targetNodeId: "openai" },
];

const analysis: EmbeddingAnalysis = {
  candidates: [
    { nodeId: "gmail", score: 0.9, supportingNodeIds: ["account-a"] },
  ],
  relatedNodes: [
    { nodeId: "account-a", similarity: 0.95 },
    { nodeId: "openai", similarity: 0.8 },
    { nodeId: "gmail", similarity: 0.7 },
    { nodeId: "unused-tag", similarity: 0.69 },
  ],
  truncatedNodeCount: 0,
};

describe("local LLM review preparation", () => {
  it("combines graph candidates with previously used reference targets", () => {
    const prepared = prepareLlmReview("source", nodes, references, analysis);

    expect(prepared).not.toBeNull();
    expect(prepared?.request.candidates.map((candidate) => candidate.name)).toEqual([
      "Gmail",
      "OpenAI",
    ]);
    expect(prepared?.request.candidates[0]).toMatchObject({
      alias: "C01",
      graphScore: 0.9,
      examples: [{ name: "历史账号 A" }],
    });
  });

  it("excludes an existing reference and a never-used node", () => {
    const prepared = prepareLlmReview(
      "source",
      nodes,
      [
        ...references,
        { sourceNodeId: "source", targetNodeId: "gmail" },
      ],
      analysis,
    );

    expect(prepared?.request.candidates.map((candidate) => candidate.name)).toEqual([
      "OpenAI",
    ]);
    expect(prepared?.request.existingReferences).toEqual([
      { name: "Gmail", content: null },
    ]);
  });

  it("maps only valid temporary aliases back to node ids", () => {
    const prepared = prepareLlmReview("source", nodes, references, analysis)!;

    expect(
      validateLlmReviewResponse(prepared, {
        selectedAliases: ["C02"],
        uncertainAliases: ["C01"],
        noMatch: false,
      }),
    ).toEqual({
      selectedNodeIds: ["openai"],
      uncertainNodeIds: ["gmail"],
      noMatch: false,
    });
  });

  it("rejects unknown, duplicated, and conflicting responses", () => {
    const prepared = prepareLlmReview("source", nodes, references, analysis)!;

    expect(() =>
      validateLlmReviewResponse(prepared, {
        selectedAliases: ["C99"],
        uncertainAliases: [],
        noMatch: false,
      }),
    ).toThrow(/unknown or repeated/);
    expect(() =>
      validateLlmReviewResponse(prepared, {
        selectedAliases: ["C01"],
        uncertainAliases: ["C01"],
        noMatch: false,
      }),
    ).toThrow(/unknown or repeated/);
    expect(() =>
      validateLlmReviewResponse(prepared, {
        selectedAliases: [],
        uncertainAliases: [],
        noMatch: false,
      }),
    ).toThrow(/no-match/);
  });

  it("fits worst-case candidates into the shared context budget", () => {
    const manyNodes: InformationNode[] = [
      node("source", "源".repeat(160), "正文".repeat(800)),
    ];
    const manyReferences: NodeReference[] = [];
    const candidates: EmbeddingAnalysis["candidates"] = [];
    const relatedNodes: EmbeddingAnalysis["relatedNodes"] = [];
    for (let index = 0; index < 24; index += 1) {
      const targetId = `target-${index}`;
      const exampleA = `example-${index}-a`;
      const exampleB = `example-${index}-b`;
      manyNodes.push(
        node(targetId, "候选".repeat(80), "候选正文".repeat(100)),
        node(exampleA, "示例甲".repeat(50), "示例正文".repeat(60)),
        node(exampleB, "示例乙".repeat(50), "示例正文".repeat(60)),
      );
      manyReferences.push(
        { sourceNodeId: exampleA, targetNodeId: targetId },
        { sourceNodeId: exampleB, targetNodeId: targetId },
      );
      candidates.push({ nodeId: targetId, score: 0.9, supportingNodeIds: [] });
      relatedNodes.push({ nodeId: targetId, similarity: 0.8 });
    }

    const prepared = prepareLlmReview("source", manyNodes, manyReferences, {
      candidates,
      relatedNodes,
      truncatedNodeCount: 0,
    });

    expect(prepared).not.toBeNull();
    expect(estimatedLlmReviewRequestTokens(prepared!.request)).toBeLessThanOrEqual(
      maximumEstimatedLlmRequestTokens,
    );
    expect(prepared!.request.candidates.length).toBeGreaterThan(0);
    expect(prepared!.aliasesToNodeIds.size).toBe(prepared!.request.candidates.length);
  });
});

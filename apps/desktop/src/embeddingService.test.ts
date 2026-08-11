import { describe, expect, it } from "vitest";
import type { InformationNode } from "./workspaceStore";
import {
  chunkEmbeddingText,
  cosineSimilarity,
  EmbeddingAnalysisFailure,
  EmbeddingAnalyzer,
  nodeEmbeddingText,
  propagateReferenceCandidates,
  type EmbeddingGateway,
  type EmbeddingInput,
} from "./embeddingService";
import { defaultEmbeddingSettings } from "./embeddingSettings";
import type {
  EmbeddingVectorCache,
  EmbeddingVectorCacheEntry,
  EmbeddingVectorCacheKey,
} from "./embeddingCache";

function node(id: string, name: string | null, content: string | null): InformationNode {
  return { id, name, content };
}

function vectorFor(input: EmbeddingInput): number[] {
  if (input.text.includes("OpenAI") || input.text.includes("模型")) {
    return [1, 0];
  }
  return [0, 1];
}

const gateway: EmbeddingGateway = {
  async embedLocal(_modelId, inputs) {
    return inputs.map(vectorFor);
  },
  async embedRemote(_configuration, inputs) {
    return inputs.map(vectorFor);
  },
};

function persistentCache(): {
  cache: EmbeddingVectorCache;
  entries: Map<string, number[]>;
} {
  const entries = new Map<string, number[]>();
  const id = (key: EmbeddingVectorCacheKey) =>
    `${key.fingerprint}:${key.role}:${key.contentHash}`;
  return {
    entries,
    cache: {
      read(keys) {
        return Promise.resolve(keys.map((key) => entries.get(id(key)) ?? null));
      },
      write(nextEntries: EmbeddingVectorCacheEntry[]) {
        nextEntries.forEach((entry) => entries.set(id(entry), entry.vector));
        return Promise.resolve();
      },
      inspect() {
        return Promise.resolve({
          persistent: true,
          entryCount: entries.size,
          diskBytes: 0,
          maxBytes: 512 * 1024 * 1024,
        });
      },
      clear() {
        entries.clear();
        return this.inspect();
      },
    },
  };
}

describe("embedding analysis", () => {
  it("combines name and content but excludes an empty node", () => {
    expect(nodeEmbeddingText(node("1", " OpenAI ", " 模型服务 "))).toBe(
      "OpenAI\n模型服务",
    );
    expect(nodeEmbeddingText(node("2", null, "  "))).toBeNull();
  });

  it("samples the whole long text with a bounded number of chunks", () => {
    const result = chunkEmbeddingText("前".repeat(8000) + "尾部");
    expect(result.chunks).toHaveLength(8);
    expect(result.truncated).toBe(true);
    expect(result.chunks[result.chunks.length - 1]).toContain("尾部");
  });

  it("uses similar records as evidence and recommends their references", async () => {
    const accountGateway: EmbeddingGateway = {
      async embedLocal(_modelId, inputs) {
        return inputs.map((input) =>
          input.text.includes("账号") ? [1, 0] : [0, 1],
        );
      },
      async embedRemote(_configuration, inputs) {
        return inputs.map((input) =>
          input.text.includes("账号") ? [1, 0] : [0, 1],
        );
      },
    };
    const analyzer = new EmbeddingAnalyzer(accountGateway);
    const result = await analyzer.analyze(
      "source",
      [
        node("source", "新账号", null),
        node("account-a", "账号 A", null),
        node("account-b", "账号 B", null),
        node("shopping-record", "购物清单", null),
        node("gmail", "Gmail", null),
        node("openai", "OpenAI", null),
        node("shopping", "购物", null),
      ],
      [
        { sourceNodeId: "account-a", targetNodeId: "gmail" },
        { sourceNodeId: "account-a", targetNodeId: "openai" },
        { sourceNodeId: "account-b", targetNodeId: "gmail" },
        { sourceNodeId: "account-b", targetNodeId: "openai" },
        { sourceNodeId: "shopping-record", targetNodeId: "shopping" },
      ],
      defaultEmbeddingSettings,
      "",
    );

    expect(result.relatedNodes.slice(0, 2).map((related) => related.nodeId)).toEqual([
      "account-a",
      "account-b",
    ]);
    expect(result.candidates.slice(0, 2).map((candidate) => candidate.nodeId)).toEqual([
      "gmail",
      "openai",
    ]);
    expect(result.candidates[0].supportingNodeIds).toEqual([
      "account-a",
      "account-b",
    ]);
    expect(result.candidates.every((candidate) => !candidate.nodeId.startsWith("account")))
      .toBe(true);
    expect(result.candidates[0].score).toBeGreaterThan(0.99);
  });

  it("does not recommend the source or an existing reference", () => {
    const candidates = propagateReferenceCandidates(
      "source",
      [
        { nodeId: "record-a", similarity: 0.95 },
        { nodeId: "record-b", similarity: 0.9 },
      ],
      [
        { sourceNodeId: "source", targetNodeId: "existing" },
        { sourceNodeId: "record-a", targetNodeId: "existing" },
        { sourceNodeId: "record-a", targetNodeId: "source" },
        { sourceNodeId: "record-a", targetNodeId: "new-tag" },
        { sourceNodeId: "record-b", targetNodeId: "new-tag" },
      ],
      new Set(["source", "record-a", "record-b", "existing", "new-tag"]),
    );

    expect(candidates.map((candidate) => candidate.nodeId)).toEqual(["new-tag"]);
    expect(candidates[0].supportingNodeIds).toEqual(["record-a", "record-b"]);
  });

  it("keeps evidence inside the nearest connected reference cluster", () => {
    const candidates = propagateReferenceCandidates(
      "source",
      [
        { nodeId: "server-script-a", similarity: 0.95 },
        { nodeId: "server-script-b", similarity: 0.91 },
        { nodeId: "account-a", similarity: 0.9 },
        { nodeId: "account-b", similarity: 0.89 },
        { nodeId: "account-c", similarity: 0.88 },
      ],
      [
        { sourceNodeId: "server-script-a", targetNodeId: "network" },
        { sourceNodeId: "server-script-b", targetNodeId: "network" },
        { sourceNodeId: "server-script-b", targetNodeId: "server" },
        { sourceNodeId: "account-a", targetNodeId: "chatgpt" },
        { sourceNodeId: "account-b", targetNodeId: "chatgpt" },
        { sourceNodeId: "account-c", targetNodeId: "chatgpt" },
      ],
      new Set([
        "source",
        "server-script-a",
        "server-script-b",
        "account-a",
        "account-b",
        "account-c",
        "network",
        "server",
        "chatgpt",
      ]),
    );

    expect(candidates.map((candidate) => candidate.nodeId)).toEqual([
      "network",
      "server",
    ]);
    expect(candidates[0].score).toBe(1);
    expect(candidates[1].score).toBeLessThan(0.5);
  });

  it("does not give a single historical record an automatic-grade score", () => {
    const candidates = propagateReferenceCandidates(
      "source",
      [{ nodeId: "only-record", similarity: 0.95 }],
      [{ sourceNodeId: "only-record", targetNodeId: "tag" }],
      new Set(["source", "only-record", "tag"]),
    );

    expect(candidates[0]).toMatchObject({
      nodeId: "tag",
      score: 0.5,
      supportingNodeIds: ["only-record"],
    });
  });

  it("rejects invalid vectors and empty source text", async () => {
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(EmbeddingAnalysisFailure);
    const analyzer = new EmbeddingAnalyzer(gateway);
    await expect(
      analyzer.analyze(
        "empty",
        [node("empty", null, null), node("candidate", "候选", null)],
        [],
        defaultEmbeddingSettings,
        "",
      ),
    ).rejects.toMatchObject({ reason: "sourceEmpty" });
  });

  it("reuses persisted role-specific vectors after creating a new analyzer", async () => {
    const storage = persistentCache();
    let gatewayCalls = 0;
    const countingGateway: EmbeddingGateway = {
      async embedLocal(_modelId, inputs) {
        gatewayCalls += 1;
        return inputs.map(vectorFor);
      },
      async embedRemote(_configuration, inputs) {
        gatewayCalls += 1;
        return inputs.map(vectorFor);
      },
    };
    const nodes = [
      node("source", "OpenAI", null),
      node("candidate", "OpenAI", null),
    ];
    await new EmbeddingAnalyzer(countingGateway, storage.cache).analyze(
      "source",
      nodes,
      [],
      defaultEmbeddingSettings,
      "",
    );
    expect(gatewayCalls).toBe(2);
    expect(storage.entries.size).toBe(2);

    const result = await new EmbeddingAnalyzer(countingGateway, storage.cache).analyze(
      "source",
      nodes,
      [],
      defaultEmbeddingSettings,
      "",
    );

    expect(gatewayCalls).toBe(2);
    expect(result.candidates).toEqual([]);
    expect(result.relatedNodes[0]).toMatchObject({
      nodeId: "candidate",
      similarity: 1,
    });
  });
});

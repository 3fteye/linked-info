import { describe, expect, it } from "vitest";
import type { InformationNode } from "./workspaceStore";
import {
  chunkEmbeddingText,
  cosineSimilarity,
  EmbeddingAnalysisFailure,
  EmbeddingAnalyzer,
  nodeEmbeddingText,
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

  it("ranks semantic candidates and excludes existing references", async () => {
    const analyzer = new EmbeddingAnalyzer(gateway);
    const result = await analyzer.analyze(
      "source",
      [
        node("source", "OpenAI 账号", null),
        node("related", "模型订阅", null),
        node("unrelated", "购物清单", null),
        node("existing", "OpenAI", null),
        node("empty", null, null),
      ],
      [{ sourceNodeId: "source", targetNodeId: "existing" }],
      defaultEmbeddingSettings,
      "",
    );

    expect(result.candidates.map((candidate) => candidate.nodeId)).toEqual([
      "related",
      "unrelated",
    ]);
    expect(result.candidates[0].score).toBe(1);
    expect(result.candidates[1].score).toBe(0);
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
    expect(result.candidates[0]).toMatchObject({ nodeId: "candidate", score: 1 });
  });
});

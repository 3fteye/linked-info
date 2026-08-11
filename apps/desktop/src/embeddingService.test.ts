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
  async embedLocal(inputs) {
    return inputs.map(vectorFor);
  },
  async embedRemote(_configuration, inputs) {
    return inputs.map(vectorFor);
  },
};

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
});

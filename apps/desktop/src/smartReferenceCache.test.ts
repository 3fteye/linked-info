import { describe, expect, it } from "vitest";
import { defaultEmbeddingSettings } from "./embeddingSettings";
import { defaultLlmSettings } from "./llmSettings";
import {
  parseCachedSmartReferenceResult,
  smartReferenceResultCacheKey,
  type CachedSmartReferenceResult,
} from "./smartReferenceCache";
import type { WorkspaceSnapshot } from "./workspaceData";

const sourceId = "00000000-0000-4000-8000-000000000001";
const candidateId = "00000000-0000-4000-8000-000000000002";

function workspace(): WorkspaceSnapshot {
  return {
    nodes: [
      { id: sourceId, name: "账号记录", content: "OpenAI Plus" },
      { id: candidateId, name: "OpenAI", content: "服务标签" },
    ],
    layout: [
      { nodeId: sourceId, x: 0, y: 0 },
      { nodeId: candidateId, x: 300, y: 0 },
    ],
    references: [],
    viewport: null,
    view: { contentProcessorByNodeId: {} },
  };
}

function result(): CachedSmartReferenceResult {
  return {
    candidates: [
      { nodeId: candidateId, score: 0.8, supportingNodeIds: [sourceId] },
    ],
    generatedAtMs: 1,
    llmEnabled: true,
    llmNoMatch: false,
    llmSelectedNodeIds: [candidateId],
    llmUncertainNodeIds: [],
    relatedNodes: [{ nodeId: candidateId, similarity: 0.75 }],
    sourceNodeId: sourceId,
    truncatedNodeCount: 0,
  };
}

describe("smart-reference result cache", () => {
  it("uses semantic workspace and model state but ignores layout ordering", async () => {
    const original = workspace();
    const reordered = {
      ...original,
      nodes: [...original.nodes].reverse(),
      layout: [...original.layout].reverse(),
    };
    const originalKey = await smartReferenceResultCacheKey(
      sourceId,
      original,
      defaultEmbeddingSettings,
      defaultLlmSettings,
    );
    await expect(
      smartReferenceResultCacheKey(
        sourceId,
        reordered,
        defaultEmbeddingSettings,
        defaultLlmSettings,
      ),
    ).resolves.toBe(originalKey);

    const changed = workspace();
    changed.nodes[1] = { ...changed.nodes[1], content: "不同服务说明" };
    await expect(
      smartReferenceResultCacheKey(
        sourceId,
        changed,
        defaultEmbeddingSettings,
        defaultLlmSettings,
      ),
    ).resolves.not.toBe(originalKey);
  });

  it("does not invalidate when only a stripped secret payload changes", async () => {
    const first = workspace();
    first.nodes[0] = {
      ...first.nodes[0],
      content: "公开说明\n[[li:secret]]first-secret[[/li]]",
    };
    const second = workspace();
    second.nodes[0] = {
      ...second.nodes[0],
      content: "公开说明\n[[li:secret]]second-secret[[/li]]",
    };
    await expect(
      smartReferenceResultCacheKey(
        sourceId,
        first,
        defaultEmbeddingSettings,
        defaultLlmSettings,
      ),
    ).resolves.toBe(
      await smartReferenceResultCacheKey(
        sourceId,
        second,
        defaultEmbeddingSettings,
        defaultLlmSettings,
      ),
    );
  });

  it("invalidates when threshold automation behavior changes", async () => {
    const original = workspace();
    const originalKey = await smartReferenceResultCacheKey(
      sourceId,
      original,
      defaultEmbeddingSettings,
      defaultLlmSettings,
    );
    await expect(
      smartReferenceResultCacheKey(
        sourceId,
        original,
        { ...defaultEmbeddingSettings, autoReferenceEnabled: true },
        defaultLlmSettings,
      ),
    ).resolves.not.toBe(originalKey);
  });

  it("rejects malformed or conflicting cached model decisions", () => {
    expect(parseCachedSmartReferenceResult(result())).toEqual(result());
    expect(
      parseCachedSmartReferenceResult({
        ...result(),
        llmUncertainNodeIds: [candidateId],
      }),
    ).toBeNull();
    expect(
      parseCachedSmartReferenceResult({
        ...result(),
        candidates: [
          { nodeId: candidateId, score: Number.NaN, supportingNodeIds: [] },
        ],
      }),
    ).toBeNull();
  });
});

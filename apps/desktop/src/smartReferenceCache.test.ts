import { describe, expect, it } from "vitest";
import { defaultEmbeddingSettings } from "./embeddingSettings";
import { defaultLlmSettings } from "./llmSettings";
import {
  filterSmartReferenceResultForWorkspace,
  parseCachedSmartReferenceResult,
  smartReferenceResultCacheKey,
  smartReferenceSourceFingerprint,
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
    sourceFingerprint: "a".repeat(64),
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

  it("tracks source text independently from unrelated node and reference changes", async () => {
    const original = workspace();
    const originalCacheKey = await smartReferenceResultCacheKey(
      sourceId,
      original,
      defaultEmbeddingSettings,
      defaultLlmSettings,
    );
    const originalFingerprint = await smartReferenceSourceFingerprint(
      sourceId,
      original,
    );
    const unrelatedChange = workspace();
    unrelatedChange.nodes[1] = {
      ...unrelatedChange.nodes[1],
      content: "已经修改的候选说明",
    };
    unrelatedChange.references = [
      { sourceNodeId: candidateId, targetNodeId: sourceId },
    ];
    await expect(
      smartReferenceSourceFingerprint(sourceId, unrelatedChange),
    ).resolves.toBe(originalFingerprint);
    await expect(
      smartReferenceResultCacheKey(
        sourceId,
        unrelatedChange,
        defaultEmbeddingSettings,
        defaultLlmSettings,
      ),
    ).resolves.not.toBe(originalCacheKey);

    const sourceChange = workspace();
    sourceChange.nodes[0] = {
      ...sourceChange.nodes[0],
      content: "另一个账号服务",
    };
    await expect(
      smartReferenceSourceFingerprint(sourceId, sourceChange),
    ).resolves.not.toBe(originalFingerprint);

    const deletedSource = workspace();
    deletedSource.nodes = deletedSource.nodes.filter((node) => node.id !== sourceId);
    await expect(
      smartReferenceSourceFingerprint(sourceId, deletedSource),
    ).resolves.toBeNull();
  });

  it("keeps a completed snapshot while filtering deleted candidates and supports", () => {
    const missingId = "00000000-0000-4000-8000-000000000003";
    const cached = result();
    cached.candidates[0] = {
      ...cached.candidates[0],
      supportingNodeIds: [sourceId, missingId],
    };
    cached.relatedNodes.push({ nodeId: missingId, similarity: 0.6 });

    const filtered = filterSmartReferenceResultForWorkspace(cached, workspace());
    expect(filtered.candidates).toEqual([
      { nodeId: candidateId, score: 0.8, supportingNodeIds: [sourceId] },
    ]);
    expect(filtered.relatedNodes).toEqual([
      { nodeId: candidateId, similarity: 0.75 },
    ]);

    const withoutCandidate = workspace();
    withoutCandidate.nodes = withoutCandidate.nodes.filter(
      (node) => node.id !== candidateId,
    );
    const emptied = filterSmartReferenceResultForWorkspace(cached, withoutCandidate);
    expect(emptied.candidates).toEqual([]);
    expect(emptied.llmSelectedNodeIds).toEqual([]);
    expect(emptied.llmNoMatch).toBe(true);
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
        sourceFingerprint: undefined,
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

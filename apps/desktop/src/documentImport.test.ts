import { describe, expect, it } from "vitest";
import {
  buildDocumentImportWorkspace,
  mergeDocumentImportCandidates,
  parseExternalDocumentImportFile,
  splitDocumentForImport,
  validateExternalDocumentImportReferences,
  validateExternalDocumentImportIsRestored,
  type DocumentImportDraft,
} from "./documentImport";
import { emptyWorkspace, type WorkspaceSnapshot } from "./workspaceData";

const existing: WorkspaceSnapshot = {
  ...emptyWorkspace(),
  nodes: [{ id: "11111111-1111-4111-8111-111111111111", name: "OpenAI", content: null }],
  layout: [{ nodeId: "11111111-1111-4111-8111-111111111111", x: 80, y: 80 }],
};

describe("document import", () => {
  it("splits on paragraph boundaries before using overlap", () => {
    expect(splitDocumentForImport("第一段\n\n第二段")).toEqual(["第一段\n\n第二段"]);
    const chunks = splitDocumentForImport("a".repeat(2_000));
    expect(chunks).toHaveLength(2);
    expect(chunks[0].slice(-160)).toBe(chunks[1].slice(0, 160));
  });

  it("merges repeated model outputs and marks exact existing names", () => {
    const candidates = mergeDocumentImportCandidates(
      [
        { nodes: [{ name: "OpenAI", content: "账号状态", referenceNames: [] }] },
        { nodes: [{ name: " openai ", content: "账号状态", referenceNames: ["服务"] }] },
      ],
      existing,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].matchedNodeId).toBe(existing.nodes[0].id);
    expect(candidates[0].referenceNames).toEqual(["服务"]);
  });

  it("parses a bounded external analysis draft and validates its references", () => {
    const external = parseExternalDocumentImportFile(
      JSON.stringify({
        schemaVersion: 1,
        kind: "linked-info-document-import-draft",
        sourceName: "accounts.txt",
        sourceText: "redacted source",
        responses: [
          {
            nodes: [
              { name: "账号 A", content: "记录", referenceNames: ["OpenAI"] },
            ],
          },
        ],
      }),
    );
    const candidates = mergeDocumentImportCandidates(external.responses, existing);
    expect(external.sourceName).toBe("accounts.txt");
    expect(() => validateExternalDocumentImportReferences(candidates, existing)).not.toThrow();
  });

  it("rejects malformed external drafts and unknown reference targets", () => {
    expect(() => parseExternalDocumentImportFile("{}"))
      .toThrow("documentImportInvalidExternalDraft");
    const external = parseExternalDocumentImportFile(
      JSON.stringify({
        schemaVersion: 1,
        kind: "linked-info-document-import-draft",
        sourceName: "accounts.txt",
        sourceText: "redacted source",
        responses: [
          {
            nodes: [
              { name: "账号 A", content: null, referenceNames: ["不存在"] },
            ],
          },
        ],
      }),
    );
    const candidates = mergeDocumentImportCandidates(external.responses, existing);
    expect(() => validateExternalDocumentImportReferences(candidates, existing))
      .toThrow("documentImportInvalidExternalDraft");
  });

  it("rejects an external draft until local placeholders have been restored", () => {
    const external = parseExternalDocumentImportFile(
      JSON.stringify({
        schemaVersion: 1,
        kind: "linked-info-document-import-draft",
        sourceName: "accounts.txt",
        sourceText: "[[LI_EMAIL_001]]",
        responses: [
          {
            nodes: [
              { name: "账号：[[LI_EMAIL_001]]", content: null, referenceNames: [] },
            ],
          },
        ],
      }),
    );
    expect(() => validateExternalDocumentImportIsRestored(external))
      .toThrow("documentImportContainsPlaceholders");
  });

  it("builds one incremental workspace transaction with source provenance", () => {
    const draft: DocumentImportDraft = {
      sourceNodeId: "33333333-3333-4333-8333-333333333333",
      sourceName: "杂项.txt",
      sourceText: "原文",
      sourceHash: "abc",
      importedAtMs: 0,
      modelId: "Qwen/Qwen3-1.7B-GGUF",
      candidates: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          name: "账号 A",
          content: "内容",
          referenceNames: ["OpenAI"],
          matchedNodeId: null,
          selected: true,
        },
      ],
    };
    const result = buildDocumentImportWorkspace(existing, draft, {
      x: 1_200,
      y: 640,
    });
    expect(result.addedNodeCount).toBe(2);
    expect(result.workspace.nodes).toHaveLength(3);
    const source = result.workspace.nodes.find((node) => node.name === "来源：杂项.txt");
    expect(source?.content).toContain("--- 原始内容 ---\n原文");
    expect(result.workspace.references).toEqual(
      expect.arrayContaining([
        { sourceNodeId: draft.candidates[0].id, targetNodeId: existing.nodes[0].id },
        { sourceNodeId: draft.candidates[0].id, targetNodeId: source?.id },
      ]),
    );
  });

  it("places the imported group at the explicit canvas anchor", () => {
    const base = structuredClone(existing);
    base.layout[0] = { ...base.layout[0], height: 300, width: 800 };
    const draft: DocumentImportDraft = {
      sourceNodeId: "33333333-3333-4333-8333-333333333333",
      sourceName: "layout.txt",
      sourceText: "source",
      sourceHash: "abc",
      importedAtMs: 0,
      modelId: "external",
      candidates: [],
    };

    const result = buildDocumentImportWorkspace(base, draft, {
      x: -480,
      y: 1_260,
    });
    expect(
      result.workspace.layout.find((item) => item.nodeId === draft.sourceNodeId),
    ).toMatchObject({ x: -480, y: 1_260 });
  });

  it("rejects a selected candidate that conflicts with its source node", () => {
    const draft: DocumentImportDraft = {
      sourceNodeId: "33333333-3333-4333-8333-333333333333",
      sourceName: "杂项.txt",
      sourceText: "原文",
      sourceHash: "abc",
      importedAtMs: 0,
      modelId: "Qwen/Qwen3-1.7B-GGUF",
      candidates: [{
        id: "22222222-2222-4222-8222-222222222222",
        name: "来源：杂项.txt",
        content: null,
        referenceNames: [],
        matchedNodeId: null,
        selected: true,
      }],
    };
    expect(() =>
      buildDocumentImportWorkspace(existing, draft, { x: 80, y: 80 }),
    ).toThrow(
      "documentImportNameConflict",
    );
  });
});

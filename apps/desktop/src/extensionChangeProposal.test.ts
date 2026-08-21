import { describe, expect, it } from "vitest";
import type { ExtensionChangeProposalV1 } from "./builtinExtensionHost";
import {
  ExtensionChangeProposalError,
  prepareExtensionChangeProposal,
} from "./extensionChangeProposal";
import { emptyWorkspace, type WorkspaceSnapshot } from "./workspaceData";

const currentId = "00000000-0000-4000-8000-000000000001";
const targetId = "00000000-0000-4000-8000-000000000002";
const createdId = "00000000-0000-4000-8000-000000000003";

function workspace(): WorkspaceSnapshot {
  return {
    ...emptyWorkspace(),
    nodes: [
      { id: currentId, name: "Source", content: "before" },
      { id: targetId, name: "Target", content: null },
    ],
    layout: [
      { nodeId: currentId, x: 10, y: 20 },
      { nodeId: targetId, x: 400, y: 20 },
    ],
  };
}

function prepare(proposal: ExtensionChangeProposalV1, base = workspace()) {
  return prepareExtensionChangeProposal(base, proposal, {
    baseRevision: 7,
    createNodeId: () => createdId,
    currentNodeId: currentId,
    handleNodeIds: new Map([
      [1n, currentId],
      [2n, targetId],
    ]),
  });
}

describe("extension change proposals", () => {
  it("builds one valid preview workspace for node, reference and content changes", () => {
    const prepared = prepare({
      baseRevision: 7,
      titleKey: "proposal.test.title",
      operations: [
        {
          type: "create-node",
          temporaryId: "created",
          name: " Created node ",
          content: "created content",
        },
        {
          type: "update-current-node",
          name: { operation: "unchanged" },
          content: { operation: "set", value: "after" },
        },
        {
          type: "create-reference",
          source: { kind: "existing", handle: 1n },
          target: { kind: "created", temporaryId: "created" },
        },
        {
          type: "create-reference",
          source: { kind: "created", temporaryId: "created" },
          target: { kind: "existing", handle: 2n },
        },
      ],
    });

    expect(prepared.workspace.nodes).toEqual([
      { id: currentId, name: "Source", content: "after" },
      { id: targetId, name: "Target", content: null },
      { id: createdId, name: "Created node", content: "created content" },
    ]);
    expect(prepared.workspace.layout[prepared.workspace.layout.length - 1]).toEqual({
      nodeId: createdId,
      x: 330,
      y: 20,
    });
    expect(prepared.workspace.references).toEqual([
      { sourceNodeId: currentId, targetNodeId: createdId },
      { sourceNodeId: createdId, targetNodeId: targetId },
    ]);
  });

  it("rejects a proposal after the invocation revision changes", () => {
    expect(() =>
      prepare({
        baseRevision: 6,
        titleKey: "proposal.test.title",
        operations: [
          {
            type: "update-current-node",
            name: { operation: "unchanged" },
            content: { operation: "set", value: "after" },
          },
        ],
      }),
    ).toThrowError(new ExtensionChangeProposalError("stale-revision"));
  });

  it("revalidates unique names against the final workspace", () => {
    expect(() =>
      prepare({
        baseRevision: 7,
        titleKey: "proposal.test.title",
        operations: [
          {
            type: "create-node",
            temporaryId: "created",
            name: " target ",
            content: "",
          },
        ],
      }),
    ).toThrowError(new ExtensionChangeProposalError("duplicate-name"));
  });

  it("rejects stale handles, duplicate references and missing removals", () => {
    const proposals: ExtensionChangeProposalV1[] = [
      {
        baseRevision: 7,
        titleKey: "proposal.test.title",
        operations: [
          {
            type: "create-reference",
            source: { kind: "existing", handle: 99n },
            target: { kind: "existing", handle: 2n },
          },
        ],
      },
      {
        baseRevision: 7,
        titleKey: "proposal.test.title",
        operations: [
          {
            type: "create-reference",
            source: { kind: "existing", handle: 1n },
            target: { kind: "existing", handle: 2n },
          },
        ],
      },
      {
        baseRevision: 7,
        titleKey: "proposal.test.title",
        operations: [
          {
            type: "remove-reference",
            source: { kind: "existing", handle: 1n },
            target: { kind: "existing", handle: 2n },
          },
        ],
      },
    ];
    expect(() => prepare(proposals[0])).toThrowError(
      new ExtensionChangeProposalError("invalid-endpoint"),
    );
    const withReference = workspace();
    withReference.references = [{ sourceNodeId: currentId, targetNodeId: targetId }];
    expect(() => prepare(proposals[1], withReference)).toThrowError(
      new ExtensionChangeProposalError("invalid-operation"),
    );
    expect(() => prepare(proposals[2])).toThrowError(
      new ExtensionChangeProposalError("invalid-operation"),
    );
  });
});

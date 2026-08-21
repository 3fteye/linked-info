import { describe, expect, it } from "vitest";
import {
  compareNodesByName,
  NodeSearchIndex,
  type NodeSearchScope,
} from "./nodeSearch";
import type { InformationNode } from "./workspaceStore";

const nodes: InformationNode[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "OpenAI 账号",
    content:
      'Codex Plus\nAPI [[li:secret note="GitHub API Key"]]synthetic-api-key[[/li]]\n[[li:totp note="OpenAI 2FA"]]JBSWY3DPEHPK3PXP[[/li]]\nTOTP: NB2W45DFOIZA',
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "代理服务",
    content: "OpenAI 可用的网络出口",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: null,
    content: "普通备注",
  },
];

function matches(query: string, scope: NodeSearchScope): string[] {
  return [...new NodeSearchIndex().matchingNodeIds(nodes, query, scope)];
}

describe("NodeSearchIndex", () => {
  it("searches name, content or both with explicit scope", () => {
    expect(matches("openai", "name")).toEqual([nodes[0].id]);
    expect(matches("openai", "content")).toEqual([nodes[0].id, nodes[1].id]);
    expect(matches("openai", "both")).toEqual([nodes[0].id, nodes[1].id]);
    expect(matches("普通备注", "content")).toEqual([nodes[2].id]);
  });

  it("does not index explicit secret or TOTP marker payloads", () => {
    expect(matches("synthetic-api-key", "content")).toEqual([]);
    expect(matches("JBSWY3DPEHPK3PXP", "content")).toEqual([]);
    expect(matches("NB2W45DFOIZA", "content")).toEqual([]);
    expect(matches("Codex Plus", "content")).toEqual([nodes[0].id]);
    expect(matches("GitHub API Key", "content")).toEqual([nodes[0].id]);
    expect(matches("OpenAI 2FA", "content")).toEqual([nodes[0].id]);
  });

  it("treats an empty normalized query as matching every node", () => {
    expect(matches("   ", "content")).toEqual(nodes.map((node) => node.id));
  });

  it("recomputes only a node whose immutable object changed", () => {
    const index = new NodeSearchIndex();
    expect([...index.matchingNodeIds(nodes, "old value", "content")]).toEqual([]);
    const updated = [
      { ...nodes[0], content: "new searchable value" },
      nodes[1],
      nodes[2],
    ];
    expect([...index.matchingNodeIds(updated, "searchable", "content")]).toEqual([
      nodes[0].id,
    ]);
  });

  it("sorts navigation results by normalized human name with unnamed nodes last", () => {
    const sortable: InformationNode[] = [
      { id: "4", name: null, content: null },
      { id: "3", name: "Account 10", content: null },
      { id: "2", name: " account 2 ", content: null },
      { id: "1", name: "Beta", content: null },
    ];

    expect(
      sortable
        .sort((left, right) => compareNodesByName(left, right, "en"))
        .map((node) => node.id),
    ).toEqual(["2", "3", "1", "4"]);
  });
});

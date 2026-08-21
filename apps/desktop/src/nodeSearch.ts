import { contentForSemanticAnalysis } from "./contentEnhancer";
import { normalizeNodeName, type InformationNode } from "./workspaceStore";

export type NodeSearchScope = "name" | "content" | "both";

export function compareNodesByName(
  left: InformationNode,
  right: InformationNode,
  locale: string,
): number {
  const leftName = normalizeNodeName(left.name ?? "");
  const rightName = normalizeNodeName(right.name ?? "");
  if (leftName.length === 0 && rightName.length > 0) {
    return 1;
  }
  if (rightName.length === 0 && leftName.length > 0) {
    return -1;
  }
  return (
    leftName.localeCompare(rightName, locale, {
      numeric: true,
      sensitivity: "base",
    }) || left.id.localeCompare(right.id)
  );
}

interface IndexedNodeText {
  content?: string;
  name?: string;
}

export class NodeSearchIndex {
  private readonly textByNode = new WeakMap<InformationNode, IndexedNodeText>();

  private textFor(node: InformationNode): IndexedNodeText {
    const cached = this.textByNode.get(node);
    if (cached !== undefined) {
      return cached;
    }

    const indexed: IndexedNodeText = {};
    this.textByNode.set(node, indexed);
    return indexed;
  }

  private contentFor(node: InformationNode): string {
    const indexed = this.textFor(node);
    indexed.content ??= normalizeNodeName(
      contentForSemanticAnalysis(node.content) ?? "",
    );
    return indexed.content;
  }

  private nameFor(node: InformationNode): string {
    const indexed = this.textFor(node);
    indexed.name ??= normalizeNodeName(node.name ?? "");
    return indexed.name;
  }

  matchingNodeIds(
    nodes: readonly InformationNode[],
    rawQuery: string,
    scope: NodeSearchScope,
  ): Set<string> {
    const query = normalizeNodeName(rawQuery);
    if (query.length === 0) {
      return new Set(nodes.map((node) => node.id));
    }

    const result = new Set<string>();
    for (const node of nodes) {
      if (
        (scope !== "content" && this.nameFor(node).includes(query)) ||
        (scope !== "name" && this.contentFor(node).includes(query))
      ) {
        result.add(node.id);
      }
    }
    return result;
  }
}

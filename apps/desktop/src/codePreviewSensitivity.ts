import { codePreviewLanguageFromProcessorId } from "./codePreviewLanguages";
import type { InformationNode } from "./workspaceData";

interface SensitivityCacheEntry {
  node: InformationNode;
  sensitive: boolean;
}

export class CodePreviewSensitivityCache {
  private readonly entries = new Map<string, SensitivityCacheEntry>();

  update(
    nodes: readonly InformationNode[],
    contentProcessorByNodeId: Readonly<Record<string, string>>,
    classify: (content: string | null) => boolean,
  ): ReadonlyMap<string, boolean> {
    const activeCodeNodeIds = new Set<string>();
    const result = new Map<string, boolean>();
    for (const node of nodes) {
      if (
        codePreviewLanguageFromProcessorId(
          contentProcessorByNodeId[node.id] ?? "",
        ) === null
      ) {
        continue;
      }
      activeCodeNodeIds.add(node.id);
      const cached = this.entries.get(node.id);
      const sensitive = cached?.node === node
        ? cached.sensitive
        : classify(node.content);
      if (cached?.node !== node) {
        this.entries.set(node.id, { node, sensitive });
      }
      result.set(node.id, sensitive);
    }
    for (const nodeId of this.entries.keys()) {
      if (!activeCodeNodeIds.has(nodeId)) {
        this.entries.delete(nodeId);
      }
    }
    return result;
  }
}

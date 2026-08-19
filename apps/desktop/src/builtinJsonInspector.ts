import type { BuiltInNodeExtension } from "./builtinExtensionHost";
import type { ExtensionMetadataPayload } from "./workspaceData";

export const builtInJsonInspectorExtensionId =
  "app.linked-info.json-inspector";
export const builtInJsonInspectorProcessorId =
  `${builtInJsonInspectorExtensionId}.inspect`;
export const builtInJsonInspectorMetadataSchemaVersion = 1;

const jsonInspectorLocalizationKeys = new Set([
  "processor.label",
  "indent.label",
  "indent.two",
  "indent.four",
  "action.set-indent",
]);

function parseJsonInspectorMetadata(value: unknown): ExtensionMetadataPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some((key) => key !== "indentSize") ||
    (candidate.indentSize !== undefined &&
      candidate.indentSize !== 2 &&
      candidate.indentSize !== 4)
  ) {
    return null;
  }
  return candidate.indentSize === 4 ? { indentSize: 4 } : {};
}

function parseEmptyMetadata(value: unknown): ExtensionMetadataPayload | null {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
    ? {}
    : null;
}

function jsonInspectorIndent(metadataJson: string | null): 2 | 4 {
  if (metadataJson === null) {
    return 2;
  }
  try {
    return parseJsonInspectorMetadata(JSON.parse(metadataJson) as unknown)
      ?.indentSize === 4
      ? 4
      : 2;
  } catch {
    return 2;
  }
}

export const builtInJsonInspectorExtension: BuiltInNodeExtension = {
  manifest: {
    id: builtInJsonInspectorExtensionId,
    metadataSchemaVersion: builtInJsonInspectorMetadataSchemaVersion,
    capabilities: [
      "node.read.content",
      "metadata.node.read",
      "metadata.node.write",
    ],
    processors: [{ id: "inspect", labelKey: "processor.label" }],
    actions: [{ id: "set-indent", labelKey: "action.set-indent" }],
    localizationKeys: jsonInspectorLocalizationKeys,
  },
  render(request) {
    if (request.processorId !== "inspect") {
      throw new Error("unknown JSON inspector processor");
    }
    const indentSize = jsonInspectorIndent(request.nodeMetadataJson);
    const source = request.node.content ?? "";
    let formatted = source;
    try {
      formatted = JSON.stringify(JSON.parse(source) as unknown, null, indentSize);
    } catch {
      // Invalid or incomplete JSON remains visible as safe plain code.
    }
    return {
      elements: [
        { type: "code", language: "json", source: formatted },
        {
          type: "select",
          actionId: "set-indent",
          labelKey: "indent.label",
          selected: String(indentSize),
          options: [
            { value: "2", labelKey: "indent.two" },
            { value: "4", labelKey: "indent.four" },
          ],
        },
      ],
    };
  },
  invoke(request) {
    if (
      request.actionId !== "set-indent" ||
      (request.inputValue !== "2" && request.inputValue !== "4")
    ) {
      throw new Error("invalid JSON inspector action");
    }
    return {
      presentation: null,
      nodeMetadataJson:
        request.inputValue === "4" ? JSON.stringify({ indentSize: 4 }) : "{}",
      workspaceMetadataJson: null,
      proposal: null,
    };
  },
  parseNodeMetadata: parseJsonInspectorMetadata,
  parseWorkspaceMetadata: parseEmptyMetadata,
};

import { describe, expect, it } from "vitest";
import {
  BuiltInExtensionHost,
  type BuiltInNodeExtension,
  type ExtensionRenderRequestV1,
} from "./builtinExtensionHost";
import { builtInExtensionHost } from "./builtinExtensions";
import {
  builtInJsonInspectorExtension,
  builtInJsonInspectorExtensionId,
  builtInJsonInspectorProcessorId,
} from "./builtinJsonInspector";

describe("built-in extension host", () => {
  it("builds a capability-limited transient snapshot and strips known secrets", () => {
    let captured: ExtensionRenderRequestV1 | null = null;
    const extension: BuiltInNodeExtension = {
      manifest: {
        id: "dev.example.snapshot",
        metadataSchemaVersion: 1,
        capabilities: ["node.read.content"],
        processors: [{ id: "inspect", labelKey: "processor.label" }],
        actions: [],
        localizationKeys: new Set(["processor.label"]),
      },
      render(request) {
        captured = request;
        return { elements: [{ type: "text", text: request.node.content ?? "" }] };
      },
      invoke() {
        throw new Error("not used");
      },
      parseNodeMetadata: () => ({}),
      parseWorkspaceMetadata: () => ({}),
    };
    const host = new BuiltInExtensionHost([extension]);

    const result = host.renderProcessor(
      "dev.example.snapshot.inspect",
      {
        content: [
          'API [[li:secret note="API key"]]synthetic-secret[[/li]]',
          "TOTP: jbsw y3dp ehpk 3pxp",
          "retained",
        ].join("\n"),
        directIncomingCount: 3,
        directOutgoingCount: 2,
        name: "must-not-be-visible",
      },
      {
        node: { setting: true },
        schemaVersion: 1,
        workspace: { setting: true },
      },
    );

    expect(result.presentation.elements[0]).toEqual({
      type: "text",
      text: "API API key\n\nretained",
    });
    expect(captured).not.toBeNull();
    expect(Object.keys(captured!.node).sort()).toEqual([
      "content",
      "directIncoming",
      "directOutgoing",
      "handle",
      "name",
    ]);
    expect(captured!.node.handle).toBe(1n);
    expect(captured!.node.name).toBeNull();
    expect(captured!.node.directIncoming).toEqual([]);
    expect(captured!.node.directOutgoing).toEqual([]);
    expect(captured!.nodeMetadataJson).toBeNull();
    expect(captured!.workspaceMetadataJson).toBeNull();
    expect(JSON.stringify(captured, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    )).not.toContain("must-not-be-visible");
    expect(captured!.node.content).not.toContain("synthetic-secret");
    expect(captured!.node.content).not.toContain("jbsw");
  });

  it("formats JSON and keeps its display preference in validated node metadata", () => {
    const rendered = builtInExtensionHost.renderProcessor(
      builtInJsonInspectorProcessorId,
      { content: '{"outer":{"value":1}}', name: "ignored" },
      { node: { indentSize: 4 }, schemaVersion: 1, workspace: {} },
    );

    expect(rendered.extensionId).toBe(builtInJsonInspectorExtensionId);
    expect(rendered.presentation.elements[0]).toEqual({
      type: "code",
      language: "json",
      source: '{\n    "outer": {\n        "value": 1\n    }\n}',
    });
    expect(rendered.presentation.elements[1]).toMatchObject({
      type: "select",
      actionId: "set-indent",
      selected: "4",
    });
    expect(rendered.presentation.elements[2]).toEqual({
      type: "button",
      actionId: "format-json",
    });

    expect(
      builtInExtensionHost.invokeAction(
        builtInJsonInspectorExtensionId,
        "set-indent",
        { content: "{}", name: null },
        { node: { indentSize: 4 }, schemaVersion: 1, workspace: {} },
        "2",
      ).nodeMetadata,
    ).toEqual({});
    expect(() =>
      builtInExtensionHost.invokeAction(
        builtInJsonInspectorExtensionId,
        "set-indent",
        { content: "{}", name: null },
        null,
        "8",
      ),
    ).toThrow("invalid JSON inspector action");

    const proposal = builtInExtensionHost.invokeAction(
      builtInJsonInspectorExtensionId,
      "format-json",
      {
        content: '{"outer":{"value":1}}',
        hostNodeId: "00000000-0000-4000-8000-000000000009",
        name: null,
      },
      { node: { indentSize: 4 }, schemaVersion: 1, workspace: {} },
      null,
      19,
    );
    expect(proposal.proposal).toMatchObject({
      baseRevision: 19,
      titleKey: "proposal.format-json.title",
    });
    expect(proposal.handleNodeIds.get(1n)).toBe(
      "00000000-0000-4000-8000-000000000009",
    );
  });

  it("does not pass incompatible metadata versions and bounds passive input", () => {
    const versionMismatch = builtInExtensionHost.renderProcessor(
      builtInJsonInspectorProcessorId,
      { content: '{"value":1}', name: null },
      { node: { indentSize: 4 }, schemaVersion: 2, workspace: {} },
    );
    expect(versionMismatch.presentation.elements[1]).toMatchObject({ selected: "2" });

    const bounded = builtInExtensionHost.renderProcessor(
      builtInJsonInspectorProcessorId,
      { content: "x".repeat(25_000), name: null },
      null,
    );
    expect(bounded.inputTruncated).toBe(true);
    expect(
      (bounded.presentation.elements[0] as { source: string }).source,
    ).toHaveLength(20_000);
  });

  it("rejects undeclared labels and actions at the host boundary", () => {
    expect(
      () =>
        new BuiltInExtensionHost([
          {
            ...builtInJsonInspectorExtension,
            manifest: {
              ...builtInJsonInspectorExtension.manifest,
              id: "dev.example.invalid",
              localizationKeys: new Set(),
            },
          },
        ]),
    ).toThrow("label is missing");
  });
});

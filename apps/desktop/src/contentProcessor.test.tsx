import { describe, expect, it } from "vitest";
import {
  ContentProcessorRegistry,
  canvasContentPreview,
  canvasExpandedCodeContentPreview,
  contentContainsSensitive,
  contentProcessorUsesCodePresentation,
  contentProcessorRegistry,
  markdownContentProcessor,
  maximumCanvasContentPreviewCharacters,
  maximumExpandedCodePreviewLines,
  textContentProcessor,
} from "./contentProcessor";
import {
  codeContentProcessorId,
  codePreviewLanguages,
} from "./codePreviewLanguages";
import { builtInJsonInspectorProcessorId } from "./builtinJsonInspector";

describe("content processor registry", () => {
  it("uses plain text by default", () => {
    const resolved = contentProcessorRegistry.resolve(null);

    expect(resolved.processor.id).toBe("text");
    expect(resolved.supported).toBe(true);
    expect(resolved.processor.kind).toBe("legacy");
    expect(
      resolved.processor.kind === "legacy"
        ? resolved.processor.present("secret")
        : null,
    ).toEqual({
      kind: "text",
      text: "secret",
    });
  });

  it("registers the built-in processors in stable order", () => {
    expect(contentProcessorRegistry.list().map((processor) => processor.id)).toEqual([
      "text",
      "markdown",
      ...codePreviewLanguages.map(codeContentProcessorId),
      builtInJsonInspectorProcessorId,
    ]);
    expect(contentProcessorRegistry.has("markdown")).toBe(true);
    expect(contentProcessorRegistry.has("code.typescript")).toBe(true);
    expect(contentProcessorRegistry.has(builtInJsonInspectorProcessorId)).toBe(true);
    expect(contentProcessorUsesCodePresentation(builtInJsonInspectorProcessorId)).toBe(
      true,
    );
    expect(markdownContentProcessor.present("# Heading")).toEqual({
      kind: "markdown",
      source: "# Heading",
    });
  });

  it("falls back safely without discarding an unknown requested id", () => {
    const resolved = contentProcessorRegistry.resolve("plugin.missing");

    expect(resolved.processor.id).toBe("text");
    expect(resolved.requestedId).toBe("plugin.missing");
    expect(resolved.supported).toBe(false);
  });

  it("rejects duplicate ids and registries without a text fallback", () => {
    expect(
      () => new ContentProcessorRegistry([textContentProcessor, textContentProcessor]),
    ).toThrow("duplicate");
    expect(() => new ContentProcessorRegistry([])).toThrow("required");
  });

  it("bounds canvas preview text without changing stored content", () => {
    const content = "a".repeat(maximumCanvasContentPreviewCharacters + 500);
    const preview = canvasContentPreview(content);

    expect(preview).toBe(`${"a".repeat(maximumCanvasContentPreviewCharacters)}…`);
    expect(content).toHaveLength(maximumCanvasContentPreviewCharacters + 500);
  });

  it("never cuts through a sensitive marker or exposes a partial payload", () => {
    const prefix = "a".repeat(maximumCanvasContentPreviewCharacters - 20);
    const payload = "synthetic-secret-".repeat(20);
    const content = `${prefix}[[li:secret]]${payload}[[/li]] retained`;
    const preview = canvasContentPreview(content);

    expect(preview).toBe(`${prefix}…`);
    expect(preview).not.toContain("synthetic-secret");
    expect(content).toContain(payload);
  });

  it("classifies sensitive content beyond the bounded canvas preview", () => {
    const content = `${"x".repeat(maximumCanvasContentPreviewCharacters + 100)}[[li:secret]]synthetic-secret[[/li]]`;

    expect(canvasContentPreview(content)).not.toContain("synthetic-secret");
    expect(contentContainsSensitive(content)).toBe(true);
  });

  it("bounds expanded code previews by both characters and lines", () => {
    const dense = Array.from({ length: maximumExpandedCodePreviewLines + 100 }, (_, index) =>
      `line ${index + 1}`,
    ).join("\n");
    const preview = canvasExpandedCodeContentPreview(dense);

    expect(preview?.endsWith("…")).toBe(true);
    expect(preview?.split("\n")).toHaveLength(maximumExpandedCodePreviewLines);
    expect(canvasExpandedCodeContentPreview("x".repeat(30_000))?.length).toBe(
      20_001,
    );
  });
});

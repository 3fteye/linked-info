import { describe, expect, it } from "vitest";
import {
  ContentProcessorRegistry,
  canvasContentPreview,
  contentProcessorRegistry,
  markdownContentProcessor,
  maximumCanvasContentPreviewCharacters,
  textContentProcessor,
} from "./contentProcessor";

describe("content processor registry", () => {
  it("uses plain text by default", () => {
    const resolved = contentProcessorRegistry.resolve(null);

    expect(resolved.processor.id).toBe("text");
    expect(resolved.supported).toBe(true);
    expect(resolved.processor.present("secret")).toEqual({
      kind: "text",
      text: "secret",
    });
  });

  it("registers the built-in processors in stable order", () => {
    expect(contentProcessorRegistry.list().map((processor) => processor.id)).toEqual([
      "text",
      "markdown",
    ]);
    expect(contentProcessorRegistry.has("markdown")).toBe(true);
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
});

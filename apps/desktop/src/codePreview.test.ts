import { describe, expect, it } from "vitest";
import { codePreviewLines } from "./codePreview";
import { codePreviewLanguages } from "./codePreviewLanguages";

function sourceFromLines(lines: ReturnType<typeof codePreviewLines>): string {
  return lines
    .map((line) => line.map((segment) => segment.text).join(""))
    .join("\n");
}

describe("codePreviewLines", () => {
  it("preserves source text for every supported language or data format", () => {
    const source = "first\n  second\n";
    for (const language of codePreviewLanguages) {
      expect(sourceFromLines(codePreviewLines(source, language))).toBe(source);
    }
  });

  it("returns structured Prism tokens without producing HTML", () => {
    const lines = codePreviewLines(
      "const answer: number = 42;\nconsole.log(answer);",
      "typescript",
    );

    expect(lines).toHaveLength(2);
    expect(
      lines[0].some(
        (segment) =>
          segment.text === "const" && segment.classNames.includes("keyword"),
      ),
    ).toBe(true);
    expect(sourceFromLines(lines)).toBe(
      "const answer: number = 42;\nconsole.log(answer);",
    );
  });
});

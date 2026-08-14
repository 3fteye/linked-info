import { describe, expect, it } from "vitest";
import {
  contentEnhancerRegistry,
  contentForSemanticAnalysis,
  ContentEnhancerRegistry,
  totpContentEnhancer,
} from "./contentEnhancer";

const syntheticSecret = "jbsw y3dp ehpk 3pxp";

describe("content enhancement", () => {
  it("extracts only explicitly prefixed TOTP lines from mixed content", () => {
    const segments = contentEnhancerRegistry.segment(
      [
        "账号：synthetic@example.test",
        `TOTP: ${syntheticSecret}`,
        "优惠码：JBSWY3DPEHPK3PXP",
        "备注：普通文字",
      ].join("\n"),
      false,
    );

    expect(segments.map((segment) => segment.kind)).toEqual([
      "text",
      "totp",
      "text",
    ]);
    expect(segments.filter((segment) => segment.kind === "totp")).toHaveLength(1);
  });

  it("does not enhance directives inside Markdown code fences", () => {
    const source = [
      "```text",
      `TOTP: ${syntheticSecret}`,
      "```",
      `TOTP: ${syntheticSecret}`,
    ].join("\n");
    const segments = contentEnhancerRegistry.segment(source, true);

    expect(segments.filter((segment) => segment.kind === "totp")).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: "text" });
  });

  it("removes valid and invalid TOTP lines before semantic analysis", () => {
    const sanitized = contentForSemanticAnalysis(
      [
        "公开说明",
        `TOTP: ${syntheticSecret}`,
        "TOTP: malformed-secret",
        "其余内容",
      ].join("\n"),
    );

    expect(sanitized).toBe("公开说明\n其余内容");
    expect(sanitized).not.toContain("TOTP");
    expect(sanitized).not.toContain("jbsw");
  });

  it("rejects duplicate enhancer identifiers", () => {
    expect(
      () => new ContentEnhancerRegistry([totpContentEnhancer, totpContentEnhancer]),
    ).toThrow("duplicate");
  });
});

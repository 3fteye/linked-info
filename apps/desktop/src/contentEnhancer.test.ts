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

  it("enhances known inline markers while preserving their surrounding text", () => {
    const source = [
      `2FA [[li:totp]]${syntheticSecret}[[/li]], note`,
      "API [[li:secret]]synthetic-api-key[[/li]] retained",
    ].join("\n");
    const segments = contentEnhancerRegistry.segment(source, false);

    expect(segments.map((segment) => segment.kind)).toEqual([
      "text",
      "marker",
      "text",
      "marker",
      "text",
    ]);
    expect(
      segments
        .filter((segment) => segment.kind === "marker")
        .map((segment) => ({ id: segment.marker.id, payload: segment.marker.payload })),
    ).toEqual([
      { id: "totp", payload: syntheticSecret },
      { id: "secret", payload: "synthetic-api-key" },
    ]);
  });

  it("keeps multiline secret selections inside one protected enhancement", () => {
    const source =
      "Recovery [[li:secret]]first synthetic line\nsecond synthetic line[[/li]] retained";
    const segments = contentEnhancerRegistry.segment(source, false);

    expect(segments).toEqual([
      { kind: "text", text: "Recovery " },
      {
        kind: "marker",
        marker: expect.objectContaining({
          id: "secret",
          payload: "first synthetic line\nsecond synthetic line",
        }),
      },
      { kind: "text", text: " retained" },
    ]);
    expect(contentForSemanticAnalysis(source)).toBe("Recovery  retained");
  });

  it("keeps inline marker examples inert inside Markdown code fences", () => {
    const source = [
      "```text",
      `[[li:totp]]${syntheticSecret}[[/li]]`,
      "[[li:secret]]synthetic-api-key[[/li]]",
      "```",
    ].join("\n");
    const segments = contentEnhancerRegistry.segment(source, true);

    expect(segments).toEqual([{ kind: "text", text: source }]);
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

  it("removes only known sensitive marker payloads from semantic analysis", () => {
    const sanitized = contentForSemanticAnalysis(
      [
        `2FA [[li:totp]]${syntheticSecret}[[/li]], note`,
        "API [[li:secret]]synthetic-api-key[[/li]] retained",
        "Unknown [[li:plugin-x]]payload[[/li]] retained",
      ].join("\n"),
    );

    expect(sanitized).toBe(
      "2FA , note\nAPI  retained\nUnknown [[li:plugin-x]]payload[[/li]] retained",
    );
    expect(sanitized).not.toContain("synthetic-api-key");
    expect(sanitized).not.toContain("jbsw");
  });

  it("rejects duplicate enhancer identifiers", () => {
    expect(
      () => new ContentEnhancerRegistry([totpContentEnhancer, totpContentEnhancer]),
    ).toThrow("duplicate");
  });
});

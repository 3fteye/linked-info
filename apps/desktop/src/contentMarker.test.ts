import { describe, expect, it } from "vitest";
import { ContentMarkerRegistry, contentMarkerRegistry } from "./contentMarker";

describe("content markers", () => {
  it("serializes and parses selected text without changing its payload", () => {
    const source = "2FA jbsw y3dp ehpk 3pxp, note";
    const start = source.indexOf("jbsw");
    const end = source.indexOf(", note");
    const wrapped = contentMarkerRegistry.wrapSelection(source, start, end, "totp");

    expect(wrapped.content).toBe(
      "2FA [[li:totp]]jbsw y3dp ehpk 3pxp[[/li]], note",
    );
    expect(wrapped.caret).toBe(wrapped.content.indexOf(", note"));
    expect(contentMarkerRegistry.segment(wrapped.content)).toEqual([
      { kind: "text", text: "2FA " },
      {
        kind: "marker",
        marker: {
          definition: { excludeFromSemanticAnalysis: true, id: "totp" },
          id: "totp",
          payload: "jbsw y3dp ehpk 3pxp",
          raw: "[[li:totp]]jbsw y3dp ehpk 3pxp[[/li]]",
        },
      },
      { kind: "text", text: ", note" },
    ]);
  });

  it("round-trips backslashes and closing delimiters in arbitrary secrets", () => {
    const payload = String.raw`prefix\[[/li]]suffix`;
    const serialized = contentMarkerRegistry.serialize("secret", payload);
    const segment = contentMarkerRegistry.segment(serialized)[0];

    expect(segment.kind).toBe("marker");
    if (segment.kind === "marker") {
      expect(segment.marker.payload).toBe(payload);
    }
  });

  it("preserves unknown and malformed markers as recoverable source", () => {
    const unknown = "before [[li:plugin-x]]payload[[/li]] after";
    const unknownSegments = contentMarkerRegistry.segment(unknown);
    expect(unknownSegments[1]).toMatchObject({
      kind: "marker",
      marker: { definition: null, id: "plugin-x", raw: "[[li:plugin-x]]payload[[/li]]" },
    });

    const malformed = "before [[li:secret]]payload";
    expect(contentMarkerRegistry.segment(malformed)).toEqual([
      { kind: "text", text: malformed },
    ]);
  });

  it("rejects invalid definitions, duplicates, unknown types, and empty selections", () => {
    expect(
      () =>
        new ContentMarkerRegistry([
          { excludeFromSemanticAnalysis: false, id: "Invalid" },
        ]),
    ).toThrow("invalid");
    expect(
      () =>
        new ContentMarkerRegistry([
          { excludeFromSemanticAnalysis: false, id: "same" },
          { excludeFromSemanticAnalysis: true, id: "same" },
        ]),
    ).toThrow("duplicate");
    expect(() => contentMarkerRegistry.serialize("missing", "value")).toThrow(
      "unknown",
    );
    expect(() => contentMarkerRegistry.wrapSelection("value", 2, 2, "secret")).toThrow(
      "selection",
    );
  });
});

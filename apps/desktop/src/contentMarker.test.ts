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
          definition: expect.objectContaining({
            excludeFromSemanticAnalysis: true,
            id: "totp",
          }),
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

  it("distinguishes plain selections, one complete marker, and unsafe crossings", () => {
    const source =
      "before [[li:secret]]synthetic-value[[/li]] between [[li:totp]]JBSWY3DPEHPK3PXP[[/li]] after";
    const secretPayload = source.indexOf("synthetic-value");
    const firstOpening = source.indexOf("[[li:secret]]");
    const firstEnd = source.indexOf(" between");

    expect(
      contentMarkerRegistry.inspectSelection(source, 0, "before".length),
    ).toMatchObject({ kind: "plain", payload: "before" });
    expect(
      contentMarkerRegistry.inspectSelection(
        source,
        secretPayload + 2,
        secretPayload + 2,
      ),
    ).toMatchObject({
      kind: "marker",
      located: { marker: { id: "secret", payload: "synthetic-value" } },
    });
    expect(
      contentMarkerRegistry.inspectSelection(
        source,
        secretPayload,
        secretPayload + 4,
      ),
    ).toMatchObject({ kind: "marker" });
    expect(
      contentMarkerRegistry.inspectSelection(source, firstOpening - 1, firstEnd),
    ).toMatchObject({ kind: "conflict" });
    expect(
      contentMarkerRegistry.inspectSelection(
        source,
        firstOpening,
        source.indexOf(" after"),
      ),
    ).toMatchObject({ kind: "conflict" });
  });

  it("changes a complete marker type and removes its wrapper without changing payload", () => {
    const source = "2FA [[li:secret]]JBSW Y3DP EHPK 3PXP[[/li]], note";
    const caret = source.indexOf("Y3DP");
    const changed = contentMarkerRegistry.applyMarker(
      source,
      caret,
      caret,
      "totp",
    );

    expect(changed).toMatchObject({ ok: true });
    if (!changed.ok) {
      throw new Error("expected marker type change to succeed");
    }
    expect(changed.content).toBe(
      "2FA [[li:totp]]JBSW Y3DP EHPK 3PXP[[/li]], note",
    );

    const removed = contentMarkerRegistry.removeMarker(
      changed.content,
      changed.content.indexOf("Y3DP"),
      changed.content.indexOf("Y3DP"),
    );
    expect(removed).toEqual({
      caret: "2FA JBSW Y3DP EHPK 3PXP".length,
      content: "2FA JBSW Y3DP EHPK 3PXP, note",
      ok: true,
    });
  });

  it("rejects invalid TOTP payloads and selections that would nest markers", () => {
    expect(
      contentMarkerRegistry.applyMarker("not-a-key", 0, 9, "totp"),
    ).toEqual({
      markerId: "totp",
      ok: false,
      reason: "invalid-payload",
    });

    const source = "prefix [[li:secret]]value[[/li]] suffix";
    const nestedAttempt = contentMarkerRegistry.applyMarker(
      source,
      source.indexOf("prefix"),
      source.indexOf(" suffix"),
      "totp",
    );
    expect(nestedAttempt).toEqual({ ok: false, reason: "conflict" });
    expect(source).toBe("prefix [[li:secret]]value[[/li]] suffix");
  });

  it("allows an unavailable marker to be removed or converted without losing data", () => {
    const source = "[[li:plugin-x]]opaque payload[[/li]]";
    const caret = source.indexOf("payload");
    expect(
      contentMarkerRegistry.removeMarker(source, caret, caret),
    ).toEqual({ caret: "opaque payload".length, content: "opaque payload", ok: true });
    expect(
      contentMarkerRegistry.applyMarker(source, caret, caret, "secret"),
    ).toMatchObject({
      content: "[[li:secret]]opaque payload[[/li]]",
      ok: true,
    });
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

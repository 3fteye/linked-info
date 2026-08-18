import { describe, expect, it } from "vitest";
import {
  ContentMarkerPresentationRegistry,
  missingContentMarkerPresentation,
  type ContentMarkerPresentation,
} from "./contentMarkerPresentation";
import {
  ContentMarkerRegistry,
  type ContentMarkerDefinition,
  type ParsedContentMarker,
} from "./contentMarker";

function presentation(id: string): ContentMarkerPresentation {
  return {
    id,
    renderCanvas() {
      return id;
    },
    renderList() {
      return id;
    },
  };
}

function marker(
  id: string,
  definition: ContentMarkerDefinition | null,
): ParsedContentMarker {
  return {
    attributes: {},
    definition,
    id,
    malformed: false,
    payload: "synthetic-payload",
    raw: `[[li:${id}]]synthetic-payload[[/li]]`,
  };
}

describe("ContentMarkerPresentationRegistry", () => {
  it("requires one presentation for every registered marker", () => {
    const markers = new ContentMarkerRegistry([
      { excludeFromSemanticAnalysis: true, id: "synthetic" },
    ]);
    const complete = new ContentMarkerPresentationRegistry([
      presentation("synthetic"),
    ]);

    expect(() => complete.assertExactCoverage(markers)).not.toThrow();
    expect(() =>
      new ContentMarkerPresentationRegistry([]).assertExactCoverage(markers),
    ).toThrow("missing=synthetic");
    expect(() =>
      new ContentMarkerPresentationRegistry([
        presentation("synthetic"),
        presentation("orphaned"),
      ]).assertExactCoverage(markers),
    ).toThrow("orphaned=orphaned");
  });

  it("rejects duplicate presentation identifiers", () => {
    expect(
      () =>
        new ContentMarkerPresentationRegistry([
          presentation("synthetic"),
          presentation("synthetic"),
        ]),
    ).toThrow("duplicate");
  });

  it("never exposes a sensitive payload when its presentation is unavailable", () => {
    const sensitiveDefinition: ContentMarkerDefinition = {
      excludeFromSemanticAnalysis: true,
      id: "synthetic",
    };
    const fallback = missingContentMarkerPresentation(
      marker("synthetic", sensitiveDefinition),
    );

    expect(fallback).toBe("synthetic: ••••••••");
    expect(fallback).not.toContain("synthetic-payload");
    expect(missingContentMarkerPresentation(marker("unknown", null))).toContain(
      "synthetic-payload",
    );
  });
});

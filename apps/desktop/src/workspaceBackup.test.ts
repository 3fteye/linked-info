import { describe, expect, it } from "vitest";
import { parseWorkspaceExport, serializeWorkspaceExport } from "./workspaceBackup";
import type { WorkspaceSnapshot } from "./workspaceData";

const nodeId = "11111111-1111-4111-8111-111111111111";

function validWorkspace(): WorkspaceSnapshot {
  return {
    nodes: [{ id: nodeId, name: "OpenAI", content: "Service" }],
    layout: [{ nodeId, x: 10, y: 20 }],
    references: [],
    viewport: { x: 120, y: -80, zoom: 1.4 },
    view: { contentProcessorByNodeId: {}, extensionMetadata: {} },
  };
}

describe("workspace backup", () => {
  it("round-trips a complete workspace", () => {
    const workspace = validWorkspace();
    const parsed = parseWorkspaceExport(serializeWorkspaceExport(workspace));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.workspace).toEqual(workspace);
    }
  });

  it("classifies invalid JSON, format, version, and workspace data", () => {
    expect(parseWorkspaceExport("not json")).toEqual({
      ok: false,
      reason: "invalidJson",
    });
    expect(parseWorkspaceExport(JSON.stringify({ format: "other" }))).toEqual({
      ok: false,
      reason: "invalidFormat",
    });
    expect(
      parseWorkspaceExport(
        JSON.stringify({
          format: "linked-info-workspace",
          version: 4,
          exportedAt: new Date().toISOString(),
          workspace: validWorkspace(),
        }),
      ),
    ).toEqual({ ok: false, reason: "unsupportedVersion" });
    expect(
      parseWorkspaceExport(
        JSON.stringify({
          format: "linked-info-workspace",
          version: 1,
          exportedAt: new Date().toISOString(),
          workspace: { nodes: [], layout: [], references: [{}] },
        }),
      ),
    ).toEqual({ ok: false, reason: "invalidWorkspace" });
  });

  it("refuses to export a snapshot that cannot be imported", () => {
    const workspace = validWorkspace();
    workspace.layout = [];

    expect(() => serializeWorkspaceExport(workspace)).toThrow(
      "refusing to export an invalid workspace snapshot",
    );
  });

  it("imports version 1 exports through the workspace migration chain", () => {
    const workspace = validWorkspace();
    const { view: _view, ...versionOne } = workspace;
    const result = parseWorkspaceExport(
      JSON.stringify({
        format: "linked-info-workspace",
        version: 1,
        exportedAt: new Date().toISOString(),
        workspace: versionOne,
      }),
    );

    expect(result).toMatchObject({ ok: true, workspace });
  });

  it("imports version 2 exports without inventing extension data", () => {
    const workspace = validWorkspace();
    const { extensionMetadata: _metadata, ...versionTwoView } = workspace.view;
    const result = parseWorkspaceExport(
      JSON.stringify({
        format: "linked-info-workspace",
        version: 2,
        exportedAt: new Date().toISOString(),
        workspace: { ...workspace, view: versionTwoView },
      }),
    );

    expect(result).toMatchObject({ ok: true, workspace });
  });
});

import { describe, expect, it } from "vitest";
import { parseWorkspaceExport, serializeWorkspaceExport } from "./workspaceBackup";
import {
  activeWorkspaceCanvas,
  defaultCanvasId,
  type WorkspaceSnapshot,
} from "./workspaceData";

const nodeId = "11111111-1111-4111-8111-111111111111";

function validWorkspace(): WorkspaceSnapshot {
  return {
    nodes: [{ id: nodeId, name: "OpenAI", content: "Service" }],
    references: [],
    view: {
      activeCanvasId: defaultCanvasId,
      canvases: [
        {
          id: defaultCanvasId,
          name: "Main",
          layout: [{ nodeId, x: 10, y: 20 }],
          viewport: { x: 120, y: -80, zoom: 1.4 },
        },
      ],
      contentProcessorByNodeId: {},
      extensionMetadata: {},
      timeline: null,
    },
  };
}

function workspaceWithBookmark(): WorkspaceSnapshot {
  const workspace = validWorkspace();
  workspace.view.bookmarks = [
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Account focus",
      canvasId: defaultCanvasId,
      x: -120,
      y: -80,
      zoom: 1.4,
    },
  ];
  return workspace;
}

function legacyWorkspace(workspace: WorkspaceSnapshot) {
  const canvas = activeWorkspaceCanvas(workspace);
  return {
    nodes: workspace.nodes,
    layout: canvas.layout,
    references: workspace.references,
    viewport: canvas.viewport,
  };
}

describe("workspace backup", () => {
  it("retains timeline metadata in portable version 6 exports", () => {
    const workspace = validWorkspace();
    workspace.view.timeline = {
      canvasId: defaultCanvasId,
      days: [{ date: "1970-01-01", nodeId }],
      captures: [],
    };
    expect(parseWorkspaceExport(serializeWorkspaceExport(workspace))).toMatchObject({
      ok: true,
      workspace,
    });
  });

  it("rejects version 6 exports with no timeline and version 5 exports with no bookmarks", () => {
    const envelope = JSON.parse(serializeWorkspaceExport(validWorkspace())) as {
      version: number;
      workspace: { view: { bookmarks?: unknown[]; timeline?: unknown } };
    };
    delete envelope.workspace.view.timeline;
    expect(parseWorkspaceExport(JSON.stringify(envelope))).toEqual({
      ok: false,
      reason: "invalidWorkspace",
    });
    envelope.version = 5;
    expect(parseWorkspaceExport(JSON.stringify(envelope))).toMatchObject({
      ok: true,
      workspace: { view: { timeline: null } },
    });
    delete envelope.workspace.view.bookmarks;
    expect(parseWorkspaceExport(JSON.stringify(envelope))).toEqual({
      ok: false,
      reason: "invalidWorkspace",
    });
  });

  it("round-trips a complete workspace", () => {
    const workspace = validWorkspace();
    const parsed = parseWorkspaceExport(serializeWorkspaceExport(workspace));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.workspace).toEqual(workspace);
    }
  });

  it("exports and imports position bookmarks in version 6", () => {
    const workspace = workspaceWithBookmark();
    const serialized = serializeWorkspaceExport(workspace);
    const envelope = JSON.parse(serialized) as {
      version: number;
      workspace: { view: { bookmarks?: unknown[] } };
    };

    expect(envelope.version).toBe(6);
    expect(envelope.workspace.view.bookmarks).toHaveLength(1);

    const parsed = parseWorkspaceExport(serialized);
    expect(parsed).toMatchObject({ ok: true, workspace });
  });

  it("rejects version 6 exports that omit the required bookmarks field", () => {
    const envelope = JSON.parse(
      serializeWorkspaceExport(workspaceWithBookmark()),
    ) as {
      workspace: { view: { bookmarks?: unknown[] } };
    };
    delete envelope.workspace.view.bookmarks;

    expect(parseWorkspaceExport(JSON.stringify(envelope))).toEqual({
      ok: false,
      reason: "invalidWorkspace",
    });
  });

  it("migrates version 4 exports without inventing position bookmarks", () => {
    const workspace = validWorkspace();
    const result = parseWorkspaceExport(
      JSON.stringify({
        format: "linked-info-workspace",
        version: 4,
        exportedAt: new Date().toISOString(),
        workspace: {
          version: 4,
          nodes: workspace.nodes,
          references: workspace.references,
          view: {
            activeCanvasId: defaultCanvasId,
            canvases: workspace.view.canvases,
            contentProcessorByNodeId: {},
            extensionMetadata: {},
          },
        },
      }),
    );

    expect(result).toMatchObject({ ok: true, workspace });
    if (result.ok) {
      expect(result.workspace.view.bookmarks).toEqual([]);
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
          version: 7,
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
    workspace.view.canvases = [];

    expect(() => serializeWorkspaceExport(workspace)).toThrow(
      "refusing to export an invalid workspace snapshot",
    );
  });

  it("imports version 1 exports through the workspace migration chain", () => {
    const workspace = validWorkspace();
    const result = parseWorkspaceExport(
      JSON.stringify({
        format: "linked-info-workspace",
        version: 1,
        exportedAt: new Date().toISOString(),
        workspace: legacyWorkspace(workspace),
      }),
    );

    expect(result).toMatchObject({ ok: true, workspace });
  });

  it("imports version 2 exports without inventing extension data", () => {
    const workspace = validWorkspace();
    const result = parseWorkspaceExport(
      JSON.stringify({
        format: "linked-info-workspace",
        version: 2,
        exportedAt: new Date().toISOString(),
        workspace: {
          ...legacyWorkspace(workspace),
          view: { contentProcessorByNodeId: {} },
        },
      }),
    );

    expect(result).toMatchObject({ ok: true, workspace });
  });

  it("imports version 3 exports into the default canvas", () => {
    const workspace = validWorkspace();
    const result = parseWorkspaceExport(
      JSON.stringify({
        format: "linked-info-workspace",
        version: 3,
        exportedAt: new Date().toISOString(),
        workspace: {
          ...legacyWorkspace(workspace),
          view: {
            contentProcessorByNodeId: {},
            extensionMetadata: {},
          },
        },
      }),
    );

    expect(result).toMatchObject({ ok: true, workspace });
  });
});

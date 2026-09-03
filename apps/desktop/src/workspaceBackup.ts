import {
  migrateWorkspaceSnapshotV1,
  migrateWorkspaceSnapshotV2,
  migrateWorkspaceSnapshotV3,
  migrateWorkspaceSnapshotV4,
  migrateWorkspaceSnapshotV5,
  parseWorkspaceSnapshot,
  parseWorkspaceSnapshotV6,
  type WorkspaceSnapshot,
} from "./workspaceData";

const exportFormat = "linked-info-workspace";
const exportVersion = 6;

export type WorkspaceImportFailure =
  | "invalidJson"
  | "invalidFormat"
  | "unsupportedVersion"
  | "invalidWorkspace";

export type WorkspaceImportResult =
  | {
      ok: true;
      exportedAt: string;
      workspace: WorkspaceSnapshot;
    }
  | {
      ok: false;
      reason: WorkspaceImportFailure;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function serializeWorkspaceExport(workspace: WorkspaceSnapshot): string {
  const validated = parseWorkspaceSnapshot(workspace);
  if (validated === null) {
    throw new Error("refusing to export an invalid workspace snapshot");
  }

  return JSON.stringify(
    {
      format: exportFormat,
      version: exportVersion,
      exportedAt: new Date().toISOString(),
      workspace: {
        ...validated,
        view: {
          ...validated.view,
          bookmarks: validated.view.bookmarks ?? [],
          timeline: validated.view.timeline ?? null,
        },
      },
    },
    null,
    2,
  );
}

export function parseWorkspaceExport(text: string): WorkspaceImportResult {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "invalidJson" };
  }

  if (!isRecord(document) || document.format !== exportFormat) {
    return { ok: false, reason: "invalidFormat" };
  }
  if (
    document.version !== 1 &&
    document.version !== 2 &&
    document.version !== 3 &&
    document.version !== 4 &&
    document.version !== 5 &&
    document.version !== exportVersion
  ) {
    return { ok: false, reason: "unsupportedVersion" };
  }
  if (
    typeof document.exportedAt !== "string" ||
    Number.isNaN(Date.parse(document.exportedAt))
  ) {
    return { ok: false, reason: "invalidFormat" };
  }
  if (
    (document.version === 5 || document.version === exportVersion) &&
    (!isRecord(document.workspace) ||
      !isRecord(document.workspace.view) ||
      !Object.prototype.hasOwnProperty.call(
        document.workspace.view,
        "bookmarks",
      ))
  ) {
    return { ok: false, reason: "invalidWorkspace" };
  }

  const workspace =
    document.version === 1
      ? migrateWorkspaceSnapshotV1(document.workspace)
      : document.version === 2
        ? migrateWorkspaceSnapshotV2(document.workspace)
        : document.version === 3
          ? migrateWorkspaceSnapshotV3(document.workspace)
          : document.version === 4
            ? migrateWorkspaceSnapshotV4(document.workspace)
            : document.version === 5
              ? migrateWorkspaceSnapshotV5(document.workspace)
              : parseWorkspaceSnapshotV6(document.workspace);
  if (workspace === null) {
    return { ok: false, reason: "invalidWorkspace" };
  }
  return { ok: true, exportedAt: document.exportedAt, workspace };
}

import {
  migrateWorkspaceSnapshotV1,
  migrateWorkspaceSnapshotV2,
  parseWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from "./workspaceData";

const exportFormat = "linked-info-workspace";
const exportVersion = 3;

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
      workspace: validated,
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

  const workspace =
    document.version === 1
      ? migrateWorkspaceSnapshotV1(document.workspace)
      : document.version === 2
        ? migrateWorkspaceSnapshotV2(document.workspace)
        : parseWorkspaceSnapshot(document.workspace);
  if (workspace === null) {
    return { ok: false, reason: "invalidWorkspace" };
  }
  return { ok: true, exportedAt: document.exportedAt, workspace };
}

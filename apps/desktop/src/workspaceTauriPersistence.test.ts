import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "./workspaceData";
import type {
  LegacyWorkspaceSource,
  WorkspaceFileBridge,
} from "./workspaceTauriPersistence";
import { createTauriWorkspacePersistence } from "./workspaceTauriPersistence";
import type {
  WorkspaceLoadResult,
  WorkspaceStorageSlot,
} from "./workspaceStore";

const nodeId = "11111111-1111-4111-8111-111111111111";

function validWorkspace(name = "OpenAI"): WorkspaceSnapshot {
  return {
    nodes: [{ id: nodeId, name, content: null }],
    layout: [{ nodeId, x: 10, y: 20 }],
    references: [],
    viewport: null,
  };
}

class MemoryFileBridge implements WorkspaceFileBridge {
  readonly files = new Map<WorkspaceStorageSlot, string>();

  async read(slot: WorkspaceStorageSlot): Promise<string | null> {
    return this.files.get(slot) ?? null;
  }

  async write(slot: WorkspaceStorageSlot, contents: string): Promise<void> {
    this.files.set(slot, contents);
  }
}

class MemoryLegacySource implements LegacyWorkspaceSource {
  readonly removed: WorkspaceStorageSlot[] = [];
  readonly values = new Map<WorkspaceStorageSlot, WorkspaceLoadResult>();

  load(slot: WorkspaceStorageSlot): WorkspaceLoadResult {
    return this.values.get(slot) ?? { status: "missing" };
  }

  remove(slot: WorkspaceStorageSlot): void {
    this.removed.push(slot);
    this.values.delete(slot);
  }
}

describe("createTauriWorkspacePersistence", () => {
  it("migrates a valid legacy workspace once and removes the browser copy", async () => {
    const bridge = new MemoryFileBridge();
    const legacy = new MemoryLegacySource();
    const workspace = validWorkspace();
    legacy.values.set("primary", { status: "ready", workspace });
    const persistence = createTauriWorkspacePersistence(bridge, legacy);

    expect(await persistence.load()).toEqual({ status: "ready", workspace });
    expect(JSON.parse(bridge.files.get("primary") ?? "null")).toEqual({
      version: 1,
      ...workspace,
    });
    expect(legacy.removed).toEqual(["primary"]);
  });

  it("never replaces an existing Rust file with stale browser data", async () => {
    const bridge = new MemoryFileBridge();
    const legacy = new MemoryLegacySource();
    const fileWorkspace = validWorkspace("File");
    const browserWorkspace = validWorkspace("Browser");
    bridge.files.set("primary", JSON.stringify({ version: 1, ...fileWorkspace }));
    legacy.values.set("primary", { status: "ready", workspace: browserWorkspace });
    const persistence = createTauriWorkspacePersistence(bridge, legacy);

    expect(await persistence.load()).toEqual({
      status: "ready",
      workspace: fileWorkspace,
    });
    expect(legacy.removed).toEqual([]);
  });

  it("preserves unreadable legacy data instead of migrating or deleting it", async () => {
    const bridge = new MemoryFileBridge();
    const legacy = new MemoryLegacySource();
    legacy.values.set("primary", { status: "invalid", raw: "{broken" });
    const persistence = createTauriWorkspacePersistence(bridge, legacy);

    expect(await persistence.load()).toEqual({
      status: "invalid",
      raw: "{broken",
    });
    expect(bridge.files.size).toBe(0);
    expect(legacy.removed).toEqual([]);
  });

  it("returns a damaged Rust file verbatim without falling back", async () => {
    const bridge = new MemoryFileBridge();
    const legacy = new MemoryLegacySource();
    bridge.files.set("primary", "{damaged");
    legacy.values.set("primary", {
      status: "ready",
      workspace: validWorkspace("Stale"),
    });
    const persistence = createTauriWorkspacePersistence(bridge, legacy);

    expect(await persistence.load()).toEqual({
      status: "invalid",
      raw: "{damaged",
    });
    expect(legacy.removed).toEqual([]);
  });

  it("validates before writing primary and recovery files", async () => {
    const bridge = new MemoryFileBridge();
    const legacy = new MemoryLegacySource();
    const persistence = createTauriWorkspacePersistence(bridge, legacy);
    const workspace = validWorkspace();

    await persistence.save(workspace);
    await persistence.preserveForRecovery(workspace);
    expect([...bridge.files.keys()]).toEqual(["primary", "recovery"]);
    expect(legacy.removed).toEqual(["primary", "recovery"]);

    await expect(
      persistence.save({ ...workspace, layout: [] }),
    ).rejects.toThrow("refusing to persist an invalid workspace snapshot");
  });

  it("serializes writes so an older snapshot cannot finish after a newer one", async () => {
    const files = new Map<WorkspaceStorageSlot, string>();
    const events: string[] = [];
    let releaseFirstWrite: () => void = () => {};
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writeCount = 0;
    const bridge: WorkspaceFileBridge = {
      async read(slot) {
        return files.get(slot) ?? null;
      },
      async write(slot, contents) {
        writeCount += 1;
        const currentWrite = writeCount;
        events.push(`start-${currentWrite}`);
        if (currentWrite === 1) {
          await firstWriteBlocked;
        }
        files.set(slot, contents);
        events.push(`finish-${currentWrite}`);
      },
    };
    const persistence = createTauriWorkspacePersistence(
      bridge,
      new MemoryLegacySource(),
    );

    const firstSave = persistence.save(validWorkspace("First"));
    const secondSave = persistence.save(validWorkspace("Second"));
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["start-1"]);

    releaseFirstWrite();
    await Promise.all([firstSave, secondSave]);

    expect(events).toEqual(["start-1", "finish-1", "start-2", "finish-2"]);
    expect(JSON.parse(files.get("primary") ?? "null").nodes[0].name).toBe(
      "Second",
    );
  });
});

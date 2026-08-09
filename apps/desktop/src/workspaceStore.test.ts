import { beforeEach, describe, expect, it, vi } from "vitest";
import { localWorkspacePersistence } from "./workspaceStore";
import type { WorkspaceSnapshot } from "./workspaceData";

const workspaceKey = "linked-info.workspace.v1";
const recoveryKey = "linked-info.workspace.recovery.v1";
const nodeId = "11111111-1111-4111-8111-111111111111";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function validWorkspace(): WorkspaceSnapshot {
  return {
    nodes: [{ id: nodeId, name: "OpenAI", content: null }],
    layout: [{ nodeId, x: 10, y: 20 }],
    references: [],
    viewport: { x: 12, y: 34, zoom: 0.8 },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

describe("localWorkspacePersistence", () => {
  it("distinguishes missing data from a valid empty workspace", async () => {
    expect(await localWorkspacePersistence.load()).toEqual({ status: "missing" });

    await localWorkspacePersistence.save({
      nodes: [],
      layout: [],
      references: [],
      viewport: null,
    });
    expect(await localWorkspacePersistence.load()).toEqual({
      status: "ready",
      workspace: { nodes: [], layout: [], references: [], viewport: null },
    });
  });

  it("round-trips a valid workspace", async () => {
    const workspace = validWorkspace();

    await localWorkspacePersistence.save(workspace);

    expect(await localWorkspacePersistence.load()).toEqual({
      status: "ready",
      workspace,
    });
  });

  it("returns unreadable primary data verbatim without overwriting it", async () => {
    const raw = "{broken-json";
    localStorage.setItem(workspaceKey, raw);

    expect(await localWorkspacePersistence.load()).toEqual({
      status: "invalid",
      raw,
    });
    expect(localStorage.getItem(workspaceKey)).toBe(raw);
  });

  it("preserves an unsupported local format version for recovery", async () => {
    const raw = JSON.stringify({ version: 2, ...validWorkspace() });
    localStorage.setItem(workspaceKey, raw);

    expect(await localWorkspacePersistence.load()).toEqual({
      status: "invalid",
      raw,
    });
    expect(localStorage.getItem(workspaceKey)).toBe(raw);
  });

  it("strictly rejects a damaged recovery copy without trimming it", async () => {
    const invalid = {
      version: 1,
      nodes: [{ id: nodeId, name: "OpenAI", content: null }],
      layout: [],
      references: [],
    };
    const raw = JSON.stringify(invalid);
    localStorage.setItem(recoveryKey, raw);

    expect(await localWorkspacePersistence.loadRecovery()).toEqual({
      status: "invalid",
      raw,
    });
    expect(localStorage.getItem(recoveryKey)).toBe(raw);
  });

  it("refuses to replace valid stored data with an invalid snapshot", async () => {
    const valid = validWorkspace();
    await localWorkspacePersistence.save(valid);
    const original = localStorage.getItem(workspaceKey);
    const invalid = { ...valid, layout: [] };

    await expect(localWorkspacePersistence.save(invalid)).rejects.toThrow(
      "refusing to persist an invalid workspace snapshot",
    );
    expect(localStorage.getItem(workspaceKey)).toBe(original);
  });

  it("supports swapping the current workspace with its recovery copy", async () => {
    const first = validWorkspace();
    const second = validWorkspace();
    second.nodes[0].name = "Second";

    await localWorkspacePersistence.preserveForRecovery(first);
    await localWorkspacePersistence.save(second);
    const recovery = await localWorkspacePersistence.loadRecovery();
    expect(recovery).toEqual({ status: "ready", workspace: first });

    await localWorkspacePersistence.preserveForRecovery(second);
    if (recovery.status === "ready") {
      await localWorkspacePersistence.save(recovery.workspace);
    }

    expect(await localWorkspacePersistence.load()).toEqual({
      status: "ready",
      workspace: first,
    });
    expect(await localWorkspacePersistence.loadRecovery()).toEqual({
      status: "ready",
      workspace: second,
    });
  });
});

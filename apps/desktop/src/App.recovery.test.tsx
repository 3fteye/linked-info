// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "./workspaceData";
import type { WorkspacePersistence } from "./workspaceStore";

const canvasHarness = vi.hoisted(() => ({
  editName: null as null | ((name: string) => void),
}));

vi.mock("./GraphCanvas", () => ({
  default: (props: {
    nodes: Array<{ id: string; name: string | null }>;
    onNodeNameChange: (nodeId: string, name: string) => void;
  }) => {
    const first = props.nodes[0];
    canvasHarness.editName = (name: string) => {
      if (first !== undefined) {
        props.onNodeNameChange(first.id, name);
      }
    };
    return <div data-testid="mock-canvas">{first?.name ?? "empty"}</div>;
  },
}));

vi.mock("./WorkspaceRestorePreview", () => ({
  default: (props: { onConfirm: () => void }) => (
    <button data-testid="workspace-restore-confirm" onClick={props.onConfirm} type="button">
      confirm
    </button>
  ),
}));

import App from "./App";
import "./i18n";
import { unavailableEmbeddingGateway, unavailableLocalEmbeddingRuntime } from "./embeddingBridge";
import { unavailableEmbeddingVectorCache } from "./embeddingCache";
import { localEmbeddingSettingsStore } from "./embeddingSettings";
import {
  unavailableDocumentImportLlmGateway,
  unavailableLlmGateway,
  unavailableLocalLlmRuntime,
} from "./llmBridge";
import { localLlmSettingsStore } from "./llmSettings";
import { unavailableOffsiteBackupService } from "./offsiteBackup";
import { unavailableSecretClipboard } from "./secretClipboard";
import { memoryOnlySmartReferenceResultCache } from "./smartReferenceCache";
import { unavailableWorkspaceBackupHistory } from "./workspaceBackupHistory";
import { unavailableWorkspaceSecurity } from "./workspaceSecurity";

const currentNodeId = "11111111-1111-4111-8111-111111111111";
const recoveryNodeId = "22222222-2222-4222-8222-222222222222";

function workspace(nodeId: string, name: string): WorkspaceSnapshot {
  return {
    nodes: [{ id: nodeId, name, content: null }],
    references: [],
    layout: [{ nodeId, x: 0, y: 0 }],
    viewport: null,
    view: { contentProcessorByNodeId: {} },
  };
}

async function find(testId: string): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (element !== null) {
      return element;
    }
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  throw new Error(`missing test element: ${testId}`);
}

async function click(testId: string): Promise<void> {
  const element = await find(testId);
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("App recovery transaction boundary", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    canvasHarness.editName = null;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("blocks a real workspace edit while a disk undo swap is pending", async () => {
    let primary = workspace(currentNodeId, "Current workspace");
    let recovery = workspace(recoveryNodeId, "Recovery workspace");
    let saveCount = 0;
    let signalSwapStarted: () => void = () => {};
    const swapStarted = new Promise<void>((resolve) => {
      signalSwapStarted = resolve;
    });
    let releaseSwap: () => void = () => {};
    const swapBlocked = new Promise<void>((resolve) => {
      releaseSwap = resolve;
    });
    const persistence: WorkspacePersistence = {
      async load() {
        return { status: "ready", workspace: primary };
      },
      async loadRecovery() {
        return { status: "ready", workspace: recovery };
      },
      async preserveForRecovery(next) {
        recovery = next;
      },
      async save(next) {
        saveCount += 1;
        primary = next;
      },
      async swapWithRecovery() {
        signalSwapStarted();
        await swapBlocked;
        const previousPrimary = primary;
        primary = recovery;
        recovery = previousPrimary;
        return { status: "committed", workspace: primary };
      },
    };

    await act(async () => {
      root.render(
        <App
          documentImportLlmGateway={unavailableDocumentImportLlmGateway}
          embeddingGateway={unavailableEmbeddingGateway}
          embeddingVectorCache={unavailableEmbeddingVectorCache}
          embeddingSettingsStore={localEmbeddingSettingsStore}
          llmGateway={unavailableLlmGateway}
          llmSettingsStore={localLlmSettingsStore}
          localEmbeddingRuntime={unavailableLocalEmbeddingRuntime}
          localLlmRuntime={unavailableLocalLlmRuntime}
          lifecycle={{ async registerCloseFlush() { return () => {}; } }}
          offsiteBackup={unavailableOffsiteBackupService}
          persistence={persistence}
          secretClipboard={unavailableSecretClipboard}
          smartReferenceResultCache={memoryOnlySmartReferenceResultCache}
          updateWorkspaceSecurityStatus={() => {}}
          workspaceBackupHistory={unavailableWorkspaceBackupHistory}
          workspaceSecurity={unavailableWorkspaceSecurity}
          workspaceSecurityStatus={{
            encrypted: false,
            locked: false,
            systemUnlockAvailable: false,
            systemUnlockEnabled: false,
            idleTimeoutMinutes: null,
          }}
        />,
      );
      await Promise.resolve();
    });

    expect((await find("mock-canvas")).textContent).toBe("Current workspace");
    await click("settings-navigation");
    await click("settings-tab-dataSecurity");
    await click("restore-recovery-workspace");
    await click("workspace-restore-confirm");
    expect((await find("mock-canvas")).textContent).toBe("Recovery workspace");

    const editDuringSwap = canvasHarness.editName;
    expect(editDuringSwap).not.toBeNull();
    await click("app-notice-action");
    await swapStarted;
    const savesWhenSwapStarted = saveCount;
    await act(async () => {
      editDuringSwap?.("Must not be accepted");
      await Promise.resolve();
    });
    expect(saveCount).toBe(savesWhenSwapStarted);

    releaseSwap();
    await act(async () => {
      await swapBlocked;
      await Promise.resolve();
    });
    expect((await find("mock-canvas")).textContent).toBe("Current workspace");
    expect(primary.nodes[0]?.name).toBe("Current workspace");
  });
});

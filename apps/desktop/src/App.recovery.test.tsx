// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "./workspaceData";
import type { WorkspacePersistence } from "./workspaceStore";

const canvasHarness = vi.hoisted(() => ({
  editName: null as null | ((name: string) => void),
  removeNodes: null as null | ((nodeIds: string[]) => void),
}));

const workspaceFileHarness = vi.hoisted(() => ({
  imported: null as null | { name: string; text: string },
}));

vi.mock("./GraphCanvas", () => ({
  default: (props: {
    nodes: Array<{ id: string; name: string | null }>;
    onDeleteNodes: (nodeIds: string[]) => void;
    onNodeNameChange: (nodeId: string, name: string) => void;
  }) => {
    const first = props.nodes[0];
    canvasHarness.editName = (name: string) => {
      if (first !== undefined) {
        props.onNodeNameChange(first.id, name);
      }
    };
    canvasHarness.removeNodes = props.onDeleteNodes;
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

vi.mock("./workspaceFileBridge", () => ({
  exportWorkspaceFile: async () => true,
  importWorkspaceFile: async () => workspaceFileHarness.imported,
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
import {
  unavailableOffsiteBackupService,
  type AutomaticBackupOutcome,
  type OffsiteBackupSnapshot,
  type OffsiteBackupService,
  type OffsiteBackupTarget,
} from "./offsiteBackup";
import { unavailableSecretClipboard } from "./secretClipboard";
import { memoryOnlySmartReferenceResultCache } from "./smartReferenceCache";
import { unavailableWorkspaceBackupHistory } from "./workspaceBackupHistory";
import {
  unavailableWorkspaceSecurity,
  type WorkspaceSecurity,
  type WorkspaceSecurityStatus,
} from "./workspaceSecurity";

const currentNodeId = "11111111-1111-4111-8111-111111111111";
const recoveryNodeId = "22222222-2222-4222-8222-222222222222";

function workspace(nodeId: string, name: string): WorkspaceSnapshot {
  return {
    nodes: [{ id: nodeId, name, content: null }],
    references: [],
    view: {
      activeCanvasId: "00000000-0000-4000-8000-000000000001",
      canvases: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "Main",
          layout: [{ nodeId, x: 0, y: 0 }],
          viewport: null,
        },
      ],
      contentProcessorByNodeId: {},
      extensionMetadata: {},
    },
  };
}

function workspaceExport(snapshot: WorkspaceSnapshot): string {
  return JSON.stringify({
    format: "linked-info-workspace",
    version: 4,
    exportedAt: "2026-08-19T00:00:00.000Z",
    workspace: snapshot,
  });
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

async function setInputValue(
  input: HTMLInputElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  throw new Error("condition did not become true");
}

async function findButton(label: RegExp): Promise<HTMLButtonElement> {
  let match: HTMLButtonElement | undefined;
  await waitUntil(() => {
    match = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => label.test(button.textContent ?? ""),
    );
    return match !== undefined;
  });
  if (match === undefined) {
    throw new Error(`missing button: ${label.source}`);
  }
  return match;
}

async function clickButton(label: RegExp): Promise<HTMLButtonElement> {
  const button = await findButton(label);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  return button;
}

function encryptedStatus(): WorkspaceSecurityStatus {
  return {
    encrypted: true,
    locked: false,
    systemUnlockAvailable: false,
    systemUnlockEnabled: false,
    idleTimeoutMinutes: 15,
  };
}

function encryptedSecurity(status: WorkspaceSecurityStatus): WorkspaceSecurity {
  return {
    ...unavailableWorkspaceSecurity,
    available: true,
    async inspect() {
      return status;
    },
    async authorizeSensitiveOperation() {
      return "one-time-authorization";
    },
  };
}

function memoryPersistence(initial: WorkspaceSnapshot): WorkspacePersistence {
  let primary = initial;
  return {
    async load() {
      return { status: "ready", workspace: primary };
    },
    async loadRecovery() {
      return { status: "missing" };
    },
    async preserveForRecovery() {},
    runExclusiveTransaction(transaction) {
      return transaction();
    },
    async save(next) {
      primary = next;
    },
    async swapWithRecovery() {
      throw new Error("swap is not used in this test");
    },
  };
}

function offsiteTarget(id: string, name: string): OffsiteBackupTarget {
  return {
    id,
    name,
    endpoint: "https://example.r2.cloudflarestorage.com",
    s3Provider: "cloudflareR2",
    region: "auto",
    bucket: "linked-info-backup",
    prefix: "linked-info/v1",
    createdAtMs: 1,
    lastUploadAtMs: null,
    lastVerifiedAtMs: null,
    lastRestoreTestAtMs: null,
    maximumUploadBytes: null,
    automaticEnabled: true,
    automaticIntervalHours: 24,
    automaticPending: false,
    lastAutomaticAttemptAtMs: null,
    lastAutomaticError: null,
    retentionEnabled: false,
    retentionMaxSnapshots: 30,
    retentionMaxAgeDays: 90,
    lastRetentionCleanupAtMs: null,
    lastRetentionError: null,
  };
}

function offsiteSnapshot(id: string, createdAtMs: number): OffsiteBackupSnapshot {
  return {
    id,
    createdAtMs,
    sizeBytes: 128,
    sha256: "a".repeat(64),
  };
}

async function openDataSecuritySettings(): Promise<void> {
  await click("settings-navigation");
  await click("settings-tab-dataSecurity");
}

async function submitCurrentPassword(): Promise<void> {
  const password = document.querySelector<HTMLInputElement>(
    "#workspace-security-current-password",
  );
  expect(password).not.toBeNull();
  if (password === null) {
    throw new Error("missing current-password input");
  }
  await setInputValue(password, "correct horse battery staple");
  await act(async () => {
    password.form?.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
}

describe("App recovery transaction boundary", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderApp(options: {
    persistence: WorkspacePersistence;
    security: WorkspaceSecurity;
    updateStatus: (status: WorkspaceSecurityStatus) => void;
    offsiteBackup?: OffsiteBackupService;
    status?: WorkspaceSecurityStatus;
  }): Promise<void> {
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
          offsiteBackup={
            options.offsiteBackup ?? unavailableOffsiteBackupService
          }
          persistence={options.persistence}
          secretClipboard={unavailableSecretClipboard}
          smartReferenceResultCache={memoryOnlySmartReferenceResultCache}
          updateWorkspaceSecurityStatus={options.updateStatus}
          workspaceBackupHistory={unavailableWorkspaceBackupHistory}
          workspaceSecurity={options.security}
          workspaceSecurityStatus={
            options.status ?? {
              encrypted: false,
              locked: false,
              systemUnlockAvailable: false,
              systemUnlockEnabled: false,
              idleTimeoutMinutes: null,
            }
          }
        />,
      );
      await Promise.resolve();
    });
  }

  async function beginEncryptedBootstrapRestore(): Promise<void> {
    await click("settings-navigation");
    await click("settings-tab-dataSecurity");
    await click("import-workspace");
    const input = document.querySelector<HTMLInputElement>(
      "#encrypted-import-password",
    );
    expect(input).not.toBeNull();
    await act(async () => {
      if (input !== null) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(input, "correct horse battery");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await Promise.resolve();
    });
    await act(async () => {
      input?.form?.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await find("workspace-restore-confirm");
  }

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    canvasHarness.editName = null;
    canvasHarness.removeNodes = null;
    workspaceFileHarness.imported = null;
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
      runExclusiveTransaction(transaction) {
        return transaction();
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

  it("reloads the authoritative Rust workspace after a committed bootstrap restore", async () => {
    const preview = workspace(recoveryNodeId, "Preview workspace");
    const authoritative = workspace(recoveryNodeId, "Authoritative Rust workspace");
    let primary = workspace(currentNodeId, "Stale React workspace");
    let exclusiveTransactions = 0;
    let commitCalls = 0;
    let signalCommitStarted: () => void = () => {};
    const commitStarted = new Promise<void>((resolve) => {
      signalCommitStarted = resolve;
    });
    let releaseCommit: () => void = () => {};
    const commitBlocked = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    workspaceFileHarness.imported = {
      name: "encrypted-backup.json",
      text: JSON.stringify({
        format: "linked-info-encrypted-workspace-export",
        version: 1,
      }),
    };
    const persistence: WorkspacePersistence = {
      async load() {
        return { status: "ready", workspace: primary };
      },
      async loadRecovery() {
        return { status: "missing" };
      },
      async preserveForRecovery() {},
      async runExclusiveTransaction(transaction) {
        exclusiveTransactions += 1;
        return transaction();
      },
      async save(next) {
        primary = next;
      },
      async swapWithRecovery() {
        throw new Error("swap is not used in this test");
      },
    };
    const restoredStatus: WorkspaceSecurityStatus = {
      encrypted: true,
      locked: false,
      systemUnlockAvailable: true,
      systemUnlockEnabled: false,
      idleTimeoutMinutes: 15,
    };
    const security: WorkspaceSecurity = {
      ...unavailableWorkspaceSecurity,
      async prepareRestore() {
        return { id: "prepared-restore", plaintext: workspaceExport(preview) };
      },
      async commitRestore() {
        commitCalls += 1;
        signalCommitStarted();
        await commitBlocked;
        primary = authoritative;
        return { status: "committed", securityStatus: restoredStatus };
      },
    };
    const updateStatus = vi.fn();

    await renderApp({
      persistence,
      security,
      updateStatus,
    });
    await beginEncryptedBootstrapRestore();
    const confirm = await find("workspace-restore-confirm");
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await commitStarted;
    expect(commitCalls).toBe(1);
    releaseCommit();
    await act(async () => {
      await commitBlocked;
      await Promise.resolve();
    });

    expect((await find("mock-canvas")).textContent).toBe(
      "Authoritative Rust workspace",
    );
    expect(exclusiveTransactions).toBe(1);
    expect(updateStatus).toHaveBeenCalledWith(restoredStatus);
  });

  it("unmounts stale workspace state when bootstrap restore committed but locked", async () => {
    const preview = workspace(recoveryNodeId, "Committed workspace");
    let primary = workspace(currentNodeId, "Must not remain mounted");
    workspaceFileHarness.imported = {
      name: "encrypted-backup.json",
      text: JSON.stringify({
        format: "linked-info-encrypted-workspace-export",
        version: 1,
      }),
    };
    const persistence: WorkspacePersistence = {
      async load() {
        return { status: "ready", workspace: primary };
      },
      async loadRecovery() {
        return { status: "missing" };
      },
      async preserveForRecovery() {},
      runExclusiveTransaction(transaction) {
        return transaction();
      },
      async save(next) {
        primary = next;
      },
      async swapWithRecovery() {
        throw new Error("swap is not used in this test");
      },
    };
    const lockedStatus: WorkspaceSecurityStatus = {
      encrypted: true,
      locked: true,
      systemUnlockAvailable: true,
      systemUnlockEnabled: false,
      idleTimeoutMinutes: 15,
    };
    const security: WorkspaceSecurity = {
      ...unavailableWorkspaceSecurity,
      async prepareRestore() {
        return { id: "prepared-restore", plaintext: workspaceExport(preview) };
      },
      async commitRestore() {
        primary = preview;
        return { status: "committedLocked", securityStatus: lockedStatus };
      },
    };
    const updateStatus = vi.fn();

    await renderApp({ persistence, security, updateStatus });
    await beginEncryptedBootstrapRestore();
    await click("workspace-restore-confirm");

    expect(document.querySelector('[data-testid="mock-canvas"]')).toBeNull();
    expect(updateStatus).toHaveBeenCalledWith(lockedStatus);
  });

  it("creates an independent canvas and keeps nodes globally available after removing a placement", async () => {
    let primary = workspace(currentNodeId, "Global node");
    const persistence: WorkspacePersistence = {
      async load() {
        return { status: "ready", workspace: primary };
      },
      async loadRecovery() {
        return { status: "missing" };
      },
      async preserveForRecovery() {},
      runExclusiveTransaction(transaction) {
        return transaction();
      },
      async save(next) {
        primary = next;
      },
      async swapWithRecovery() {
        throw new Error("swap is not used in this test");
      },
    };

    await renderApp({
      persistence,
      security: unavailableWorkspaceSecurity,
      updateStatus: () => {},
    });
    expect((await find("mock-canvas")).textContent).toBe("Global node");

    await click("canvas-create");
    expect((await find("mock-canvas")).textContent).toBe("empty");
    const picker = (await find("canvas-select")) as HTMLSelectElement;
    expect(picker.options).toHaveLength(2);
    expect(primary.view.canvases).toHaveLength(2);

    await click("nodes-navigation");
    await click("node-list-row");
    expect((await find("mock-canvas")).textContent).toBe("Global node");
    expect(primary.view.canvases[1].layout).toEqual([
      expect.objectContaining({ nodeId: currentNodeId }),
    ]);

    await act(async () => {
      canvasHarness.removeNodes?.([currentNodeId]);
      await Promise.resolve();
    });
    expect((await find("mock-canvas")).textContent).toBe("empty");
    expect(primary.nodes).toEqual([
      { id: currentNodeId, name: "Global node", content: null },
    ]);
    expect(primary.view.canvases[0].layout).toHaveLength(1);
    expect(primary.view.canvases[1].layout).toHaveLength(0);
  });

  it("does not reuse a completed bookmark rename as the next bookmark name", async () => {
    let primary = workspace(currentNodeId, "Global node");
    primary.view.bookmarks = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "Existing bookmark",
        canvasId: primary.view.activeCanvasId,
        x: 0,
        y: 0,
        zoom: 1,
      },
    ];
    const persistence: WorkspacePersistence = {
      async load() {
        return { status: "ready", workspace: primary };
      },
      async loadRecovery() {
        return { status: "missing" };
      },
      async preserveForRecovery() {},
      runExclusiveTransaction(transaction) {
        return transaction();
      },
      async save(next) {
        primary = next;
      },
      async swapWithRecovery() {
        throw new Error("swap is not used in this test");
      },
    };

    await renderApp({
      persistence,
      security: unavailableWorkspaceSecurity,
      updateStatus: () => {},
    });
    await click("canvas-bookmarks-toggle");
    await click("canvas-bookmark-rename");
    const renameInput = document.querySelector<HTMLInputElement>(
      ".canvas-bookmark-rename-input",
    );
    expect(renameInput?.value).toBe("Existing bookmark");

    await act(async () => {
      renameInput?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
      );
      await Promise.resolve();
    });

    const createInput = (await find("canvas-bookmark-name")) as HTMLInputElement;
    expect(createInput.value).toBe("");
    await click("canvas-bookmark-save");

    expect(primary.view.bookmarks).toHaveLength(2);
    expect(primary.view.bookmarks?.[0].name).toBe("Existing bookmark");
    expect(primary.view.bookmarks?.[1].name).not.toBe("Existing bookmark");
  });

  it("does not optimistically apply an offsite target when config recovery is required", async () => {
    let primary = workspace(currentNodeId, "Encrypted workspace");
    const persistence: WorkspacePersistence = {
      async load() {
        return { status: "ready", workspace: primary };
      },
      async loadRecovery() {
        return { status: "missing" };
      },
      async preserveForRecovery() {},
      runExclusiveTransaction(transaction) {
        return transaction();
      },
      async save(next) {
        primary = next;
      },
      async swapWithRecovery() {
        throw new Error("swap is not used in this test");
      },
    };
    const encryptedStatus: WorkspaceSecurityStatus = {
      encrypted: true,
      locked: false,
      systemUnlockAvailable: false,
      systemUnlockEnabled: false,
      idleTimeoutMinutes: 15,
    };
    const security: WorkspaceSecurity = {
      ...unavailableWorkspaceSecurity,
      available: true,
      async inspect() {
        return encryptedStatus;
      },
      async authorizeSensitiveOperation() {
        return "one-time-authorization";
      },
    };
    const inspectTargets = vi.fn(async () => []);
    const configureS3Target = vi.fn(async () => ({
      status: "recoveryRequired" as const,
    }));
    const offsiteBackup: OffsiteBackupService = {
      ...unavailableOffsiteBackupService,
      available: true,
      inspectTargets,
      configureS3Target,
      async runDueAutomatic() {
        return [];
      },
    };

    await renderApp({
      persistence,
      security,
      updateStatus: () => {},
      offsiteBackup,
      status: encryptedStatus,
    });
    await click("settings-navigation");
    await click("settings-tab-dataSecurity");

    await setInputValue(
      (await find("offsite-s3-endpoint")) as HTMLInputElement,
      "https://example.r2.cloudflarestorage.com",
    );
    await setInputValue(
      (await find("offsite-s3-bucket")) as HTMLInputElement,
      "linked-info-backup",
    );
    await setInputValue(
      (await find("offsite-s3-access-key-id")) as HTMLInputElement,
      "access-key-id",
    );
    await setInputValue(
      (await find("offsite-s3-secret-access-key")) as HTMLInputElement,
      "secret-access-key",
    );
    await setInputValue(
      (await find("offsite-s3-session-token")) as HTMLInputElement,
      "session-token",
    );
    await click("offsite-save-target");

    const password = document.querySelector<HTMLInputElement>(
      "#workspace-security-current-password",
    );
    expect(password).not.toBeNull();
    if (password === null) {
      throw new Error("missing current-password input");
    }
    await setInputValue(password, "correct horse battery staple");
    await act(async () => {
      password.form?.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    const message = await find("offsite-config-recovery-message");
    expect(message.textContent).toMatch(/paused|暂停/);
    expect(configureS3Target).toHaveBeenCalledOnce();
    expect(inspectTargets.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(
      (await find("offsite-s3-access-key-id") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (await find("offsite-s3-secret-access-key") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (await find("offsite-s3-session-token") as HTMLInputElement).value,
    ).toBe("");
    expect(
      document.querySelector("#workspace-security-current-password"),
    ).toBeNull();
    expect((await find("offsite-save-target") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(document.querySelector(".offsite-target-selector")).toBeNull();
  });

  it("discards a deferred automatic result after config recovery and does not reschedule marking", async () => {
    const status = encryptedStatus();
    const targetId = "33333333-3333-4333-8333-333333333333";
    const initialTarget = offsiteTarget(targetId, "Initial target");
    const authoritativeTarget = offsiteTarget(targetId, "Authoritative target");
    const staleTarget = offsiteTarget(targetId, "Stale automatic target");
    const automatic = deferred<AutomaticBackupOutcome[]>();
    const inspectTargets = vi
      .fn<OffsiteBackupService["inspectTargets"]>()
      .mockResolvedValueOnce([initialTarget])
      .mockResolvedValueOnce([authoritativeTarget])
      .mockResolvedValue([staleTarget]);
    const markAutomaticPending = vi.fn<
      OffsiteBackupService["markAutomaticPending"]
    >(async () => ({ status: "committed", targets: [staleTarget] }));
    const runDueAutomatic = vi.fn<OffsiteBackupService["runDueAutomatic"]>(
      () => automatic.promise,
    );
    const configureS3Target = vi.fn<
      OffsiteBackupService["configureS3Target"]
    >(async () => ({ status: "recoveryRequired" }));
    const offsiteBackup: OffsiteBackupService = {
      ...unavailableOffsiteBackupService,
      available: true,
      inspectTargets,
      configureS3Target,
      markAutomaticPending,
      runDueAutomatic,
      async list() {
        return { items: [], nextCursor: null };
      },
    };

    await renderApp({
      persistence: memoryPersistence(workspace(currentNodeId, "Initial node")),
      security: encryptedSecurity(status),
      updateStatus: () => {},
      offsiteBackup,
      status,
    });
    await waitUntil(() => runDueAutomatic.mock.calls.length === 1);

    const editName = canvasHarness.editName;
    expect(editName).not.toBeNull();
    await act(async () => {
      editName?.("Changed while automatic upload is pending");
      await Promise.resolve();
    });
    await openDataSecuritySettings();
    await setInputValue(
      (await find("offsite-s3-endpoint")) as HTMLInputElement,
      "https://example.r2.cloudflarestorage.com",
    );
    await setInputValue(
      (await find("offsite-s3-bucket")) as HTMLInputElement,
      "linked-info-backup",
    );
    await setInputValue(
      (await find("offsite-s3-access-key-id")) as HTMLInputElement,
      "access-key-id",
    );
    await setInputValue(
      (await find("offsite-s3-secret-access-key")) as HTMLInputElement,
      "secret-access-key",
    );
    await click("offsite-save-target");
    await submitCurrentPassword();
    await find("offsite-config-recovery-message");

    const inspectCallsAfterRecovery = inspectTargets.mock.calls.length;
    automatic.resolve([
      {
        status: "committed",
        targetId,
        uploaded: true,
        error: null,
      },
    ]);
    await act(async () => {
      await automatic.promise;
      await Promise.resolve();
    });

    expect(inspectTargets).toHaveBeenCalledTimes(inspectCallsAfterRecovery);
    expect(markAutomaticPending).not.toHaveBeenCalled();
    expect(runDueAutomatic).toHaveBeenCalledOnce();
    expect(
      Array.from(
        document.querySelectorAll<HTMLOptionElement>(
          ".offsite-target-selector option",
        ),
      ).map((option) => option.textContent),
    ).toEqual(["Authoritative target"]);
  });

  it("keeps config recovery visible while allowing read-only refresh and restore after snapshot deletion", async () => {
    const status = encryptedStatus();
    const target = offsiteTarget(
      "44444444-4444-4444-8444-444444444444",
      "Recovery target",
    );
    const deletedSnapshot = offsiteSnapshot(
      "55555555-5555-4555-8555-555555555555",
      1_786_000_000_000,
    );
    const remainingSnapshot = offsiteSnapshot(
      "66666666-6666-4666-8666-666666666666",
      1_786_000_100_000,
    );
    const page = {
      items: [deletedSnapshot, remainingSnapshot],
      nextCursor: null,
    };
    const inspectTargets = vi.fn(async () => [target]);
    const list = vi.fn(async () => page);
    const deleteSnapshot = vi.fn<OffsiteBackupService["deleteSnapshot"]>(
      async () => ({ status: "recoveryRequired", snapshotDeleted: true }),
    );
    const download = vi.fn<OffsiteBackupService["download"]>(async () => ({
      metadata: remainingSnapshot,
      encryptedExport: "encrypted-restore-preview",
    }));
    const offsiteBackup: OffsiteBackupService = {
      ...unavailableOffsiteBackupService,
      available: true,
      inspectTargets,
      list,
      deleteSnapshot,
      download,
      async runDueAutomatic() {
        return [];
      },
    };

    await renderApp({
      persistence: memoryPersistence(workspace(currentNodeId, "Encrypted node")),
      security: encryptedSecurity(status),
      updateStatus: () => {},
      offsiteBackup,
      status,
    });
    await openDataSecuritySettings();
    await waitUntil(
      () => document.querySelectorAll(".offsite-entry-actions").length === 2,
    );

    await clickButton(/删除快照|Delete snapshot/);
    await submitCurrentPassword();
    const recoveryBanner = await find("offsite-config-recovery-message");
    const recoveryMessage = recoveryBanner.textContent;
    expect(recoveryBanner.textContent).toMatch(/deleted|删除/);
    expect(deleteSnapshot).toHaveBeenCalledOnce();
    expect(document.querySelectorAll(".offsite-entry-actions")).toHaveLength(0);
    expect(document.querySelector(".app-status-toast")).toBeNull();

    const refresh = await findButton(/刷新|Refresh/);
    expect(refresh.disabled).toBe(false);
    await clickButton(/刷新|Refresh/);
    await waitUntil(
      () => document.querySelectorAll(".offsite-entry-actions").length === 2,
    );
    expect((await find("offsite-config-recovery-message")).textContent).toBe(
      recoveryMessage,
    );

    const restore = await findButton(/恢复预览|Restore preview/);
    expect(restore.disabled).toBe(false);
    await clickButton(/恢复预览|Restore preview/);
    expect(download).toHaveBeenCalledOnce();
    expect(document.querySelector("#encrypted-import-password")).not.toBeNull();
    expect((await find("offsite-config-recovery-message")).textContent).toBe(
      recoveryMessage,
    );
  });

  it("coordinates config recovery when the committed snapshot-delete refresh rejects", async () => {
    const status = encryptedStatus();
    const target = offsiteTarget(
      "99999999-9999-4999-8999-999999999999",
      "Refresh recovery target",
    );
    const snapshot = offsiteSnapshot(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      1_786_000_150_000,
    );
    const inspectTargets = vi
      .fn<OffsiteBackupService["inspectTargets"]>()
      .mockResolvedValueOnce([target])
      .mockRejectedValueOnce(
        new Error("offsite_backup_config_recovery_required"),
      )
      .mockResolvedValue([target]);
    const deleteSnapshot = vi.fn<OffsiteBackupService["deleteSnapshot"]>(
      async () => ({
        status: "committed",
        snapshotDeleted: true,
        restoreDrillProofInvalidated: false,
        warning: null,
      }),
    );
    const offsiteBackup: OffsiteBackupService = {
      ...unavailableOffsiteBackupService,
      available: true,
      inspectTargets,
      async list() {
        return { items: [snapshot], nextCursor: null };
      },
      deleteSnapshot,
      async runDueAutomatic() {
        return [];
      },
    };

    await renderApp({
      persistence: memoryPersistence(workspace(currentNodeId, "Encrypted node")),
      security: encryptedSecurity(status),
      updateStatus: () => {},
      offsiteBackup,
      status,
    });
    await openDataSecuritySettings();
    await clickButton(/删除快照|Delete snapshot/);
    await submitCurrentPassword();

    const recoveryBanner = await find("offsite-config-recovery-message");
    expect(recoveryBanner.textContent).toMatch(/paused|暂停/);
    expect(deleteSnapshot).toHaveBeenCalledOnce();
    expect(inspectTargets.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector(".app-status-toast")).toBeNull();
  });

  it("closes the restore drill and clears its password when config recovery is required", async () => {
    const status = encryptedStatus();
    const target = offsiteTarget(
      "77777777-7777-4777-8777-777777777777",
      "Restore-drill target",
    );
    const snapshot = offsiteSnapshot(
      "88888888-8888-4888-8888-888888888888",
      1_786_000_200_000,
    );
    const testRestore = vi.fn<OffsiteBackupService["testRestore"]>(
      async () => ({
        status: "recoveryRequired",
      }),
    );
    const offsiteBackup: OffsiteBackupService = {
      ...unavailableOffsiteBackupService,
      available: true,
      async inspectTargets() {
        return [target];
      },
      async list() {
        return { items: [snapshot], nextCursor: null };
      },
      testRestore,
      async runDueAutomatic() {
        return [];
      },
    };

    await renderApp({
      persistence: memoryPersistence(workspace(currentNodeId, "Encrypted node")),
      security: encryptedSecurity(status),
      updateStatus: () => {},
      offsiteBackup,
      status,
    });
    await openDataSecuritySettings();
    await clickButton(/恢复演练|Recovery drill/);
    const password = document.querySelector<HTMLInputElement>(
      "#offsite-restore-drill-password",
    );
    expect(password).not.toBeNull();
    if (password === null) {
      throw new Error("missing restore-drill password input");
    }
    await setInputValue(password, "snapshot master password");
    await act(async () => {
      password.form?.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    const recoveryBanner = await find("offsite-config-recovery-message");
    expect(recoveryBanner.textContent).toMatch(/drill|演练/);
    expect(testRestore).toHaveBeenCalledWith(
      target.id,
      snapshot.id,
      "snapshot master password",
    );
    expect(
      document.querySelector("#offsite-restore-drill-password"),
    ).toBeNull();
    expect(document.querySelector(".app-status-toast")).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /恢复演练通过|Recovery drill passed/,
    );
  });
});

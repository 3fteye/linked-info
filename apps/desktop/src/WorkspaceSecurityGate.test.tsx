// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceSecurityGate from "./WorkspaceSecurityGate";
import "./i18n";
import type {
  WorkspaceSecurity,
  WorkspaceSecurityStatus,
} from "./workspaceSecurity";

const unlocked: WorkspaceSecurityStatus = {
  encrypted: true,
  locked: false,
  systemUnlockAvailable: false,
  systemUnlockEnabled: false,
  idleTimeoutMinutes: 15,
};

const locked: WorkspaceSecurityStatus = { ...unlocked, locked: true };

function security(listenerRef: { current: ((reason: string) => void) | null }) {
  return {
    available: true,
    inspect: vi.fn(async () => unlocked),
    unlock: vi.fn(async () => unlocked),
    unlockWithSystem: vi.fn(async () => unlocked),
    subscribeLocked: vi.fn(async (listener: (reason: string) => void) => {
      listenerRef.current = listener;
      return () => {
        listenerRef.current = null;
      };
    }),
    recordActivity: vi.fn(async () => undefined),
  } as unknown as WorkspaceSecurity;
}

describe("WorkspaceSecurityGate", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("unmounts unlocked content immediately after a Rust lock event", async () => {
    const listenerRef = { current: null as ((reason: string) => void) | null };
    const workspaceSecurity = security(listenerRef);
    await act(async () => {
      root.render(
        <WorkspaceSecurityGate security={workspaceSecurity}>
          {() => <div data-testid="secret-content">secret</div>}
        </WorkspaceSecurityGate>,
      );
    });
    expect(container.querySelector('[data-testid="secret-content"]')).not.toBeNull();

    act(() => listenerRef.current?.("windows_session_locked"));

    expect(container.querySelector('[data-testid="secret-content"]')).toBeNull();
    expect(container.querySelector(".security-gate")).not.toBeNull();
  });

  it("keeps the recovery-required boundary above the unmounted App", async () => {
    const listenerRef = { current: null as ((reason: string) => void) | null };
    const workspaceSecurity = security(listenerRef);
    await act(async () => {
      root.render(
        <WorkspaceSecurityGate security={workspaceSecurity}>
          {() => <div data-testid="secret-content">secret</div>}
        </WorkspaceSecurityGate>,
      );
    });

    await act(async () => {
      listenerRef.current?.("workspace_password_change_recovery_required");
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="secret-content"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="workspace-security-recovery-required"]'),
    ).not.toBeNull();
    expect(container.querySelector("#workspace-unlock-password")).toBeNull();
  });

  it("recreates an unencrypted owner after session revocation without a password prompt", async () => {
    const listenerRef = { current: null as ((reason: string) => void) | null };
    const workspaceSecurity = security(listenerRef);
    vi.mocked(workspaceSecurity.inspect).mockResolvedValue({ ...unlocked, encrypted: false });
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Owner() {
      useEffect(() => { mounted(); return () => { unmounted(); }; }, []);
      return <div data-testid="plaintext-owner" />;
    }
    await act(async () => {
      root.render(<WorkspaceSecurityGate security={workspaceSecurity}>{() => <Owner />}</WorkspaceSecurityGate>);
    });
    await act(async () => { listenerRef.current?.("windows_session_locked"); });
    expect(mounted).toHaveBeenCalledTimes(2);
    expect(unmounted).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="plaintext-owner"]')).not.toBeNull();
    expect(container.querySelector("#workspace-unlock-password")).toBeNull();
  });

  it("keeps capsule durability recovery closed even in plaintext mode", async () => {
    const listenerRef = { current: null as ((reason: string) => void) | null };
    const workspaceSecurity = security(listenerRef);
    vi.mocked(workspaceSecurity.inspect).mockResolvedValue({ ...unlocked, encrypted: false });
    await act(async () => {
      root.render(<WorkspaceSecurityGate security={workspaceSecurity}>{() => <div data-testid="plaintext-owner" />}</WorkspaceSecurityGate>);
    });
    await act(async () => { listenerRef.current?.("capsule_recovery_required"); });
    expect(container.querySelector('[data-testid="plaintext-owner"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-security-recovery-required"]')).not.toBeNull();
  });

  it("uses a native process restart instead of reloading the quarantined WebView", async () => {
    const listenerRef = { current: null as ((reason: string) => void) | null };
    const workspaceSecurity = security(listenerRef);
    const restart = vi.fn(async () => undefined);
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    await act(async () => {
      root.render(
        <WorkspaceSecurityGate
          lifecycle={{ restart, registerCloseFlush: async () => () => {} }}
          security={workspaceSecurity}
        >
          {() => <div data-testid="secret-content" />}
        </WorkspaceSecurityGate>,
      );
    });
    await act(async () => { listenerRef.current?.("capsule_recovery_required"); });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-security-recovery-required"] button',
    );
    if (button === null) throw new Error("missing recovery restart button");

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(restart).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="secret-content"]')).toBeNull();
  });

  it("keeps recovery closed and shows a retryable message when native restart fails", async () => {
    const listenerRef = { current: null as ((reason: string) => void) | null };
    const workspaceSecurity = security(listenerRef);
    let rejectRestart: (reason: Error) => void = () => {};
    const restart = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectRestart = reject;
    }));
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    await act(async () => {
      root.render(
        <WorkspaceSecurityGate
          lifecycle={{ restart, registerCloseFlush: async () => () => {} }}
          security={workspaceSecurity}
        >
          {() => <div data-testid="secret-content" />}
        </WorkspaceSecurityGate>,
      );
    });
    await act(async () => { listenerRef.current?.("workspace_owner_recovery_required"); });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-security-recovery-required"] button',
    );
    if (button === null) throw new Error("missing recovery restart button");
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(restart).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);

    await act(async () => { rejectRestart(new Error("synthetic restart failure")); });

    expect(button.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain("could not restart automatically");
    expect(container.querySelector('[data-testid="secret-content"]')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("retains reload as the browser fallback when no native restart exists", async () => {
    const listenerRef = { current: null as ((reason: string) => void) | null };
    const workspaceSecurity = security(listenerRef);
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    await act(async () => {
      root.render(
        <WorkspaceSecurityGate security={workspaceSecurity}>
          {() => <div data-testid="secret-content" />}
        </WorkspaceSecurityGate>,
      );
    });
    await act(async () => { listenerRef.current?.("capsule_recovery_required"); });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-security-recovery-required"] button',
    );
    if (button === null) throw new Error("missing recovery restart button");
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(reload).toHaveBeenCalledOnce();
  });

  it("tells the user that a committed password change requires the new password", async () => {
    const listenerRef = { current: null as ((reason: string) => void) | null };
    const workspaceSecurity = security(listenerRef);
    vi.mocked(workspaceSecurity.inspect)
      .mockResolvedValueOnce(unlocked)
      .mockResolvedValue({ ...unlocked, locked: true });
    await act(async () => {
      root.render(
        <WorkspaceSecurityGate security={workspaceSecurity}>
          {() => <div data-testid="secret-content">secret</div>}
        </WorkspaceSecurityGate>,
      );
    });

    await act(async () => {
      listenerRef.current?.("workspace_password_changed_locked");
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="secret-content"]')).toBeNull();
    expect(container.querySelector("#workspace-unlock-password")).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "new master password",
    );
  });

  it("does not let a stale command result reopen the App after a lock event", async () => {
    const listenerRef = { current: null as ((reason: string) => void) | null };
    const workspaceSecurity = security(listenerRef);
    vi.mocked(workspaceSecurity.inspect)
      .mockResolvedValueOnce(unlocked)
      .mockResolvedValue({ ...unlocked, locked: true });
    let updateFromWorkspace: ((status: WorkspaceSecurityStatus) => void) | null = null;
    await act(async () => {
      root.render(
        <WorkspaceSecurityGate security={workspaceSecurity}>
          {(_status, updateStatus) => {
            updateFromWorkspace = updateStatus;
            return <div data-testid="secret-content">secret</div>;
          }}
        </WorkspaceSecurityGate>,
      );
    });

    await act(async () => {
      listenerRef.current?.("idle_timeout");
      await Promise.resolve();
    });
    act(() => {
      const update = updateFromWorkspace as
        | ((status: WorkspaceSecurityStatus) => void)
        | null;
      update?.(unlocked);
    });

    expect(container.querySelector('[data-testid="secret-content"]')).toBeNull();
    expect(container.querySelector("#workspace-unlock-password")).not.toBeNull();
  });

  it("keeps content unmounted while a rotation start becomes a terminal failure", async () => {
    const listenerRef = { current: null as ((reason: string) => void) | null };
    const workspaceSecurity = security(listenerRef);
    let resolveStartedInspection!: (status: WorkspaceSecurityStatus) => void;
    const startedInspection = new Promise<WorkspaceSecurityStatus>((resolve) => {
      resolveStartedInspection = resolve;
    });
    vi.mocked(workspaceSecurity.inspect)
      .mockResolvedValueOnce(unlocked)
      .mockReturnValueOnce(startedInspection)
      .mockResolvedValue({ ...unlocked, locked: true });
    await act(async () => {
      root.render(
        <WorkspaceSecurityGate security={workspaceSecurity}>
          {() => <div data-testid="secret-content">secret</div>}
        </WorkspaceSecurityGate>,
      );
    });

    act(() => {
      listenerRef.current?.("workspace_data_key_rotation_started");
    });
    expect(container.querySelector('[data-testid="secret-content"]')).toBeNull();

    await act(async () => {
      listenerRef.current?.("workspace_data_key_rotation_failed");
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="secret-content"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "plaintext access was revoked",
    );

    await act(async () => {
      resolveStartedInspection(unlocked);
      await startedInspection;
    });
    expect(container.querySelector('[data-testid="secret-content"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "plaintext access was revoked",
    );
  });

  it("discards an unlock result superseded by a newer lock event", async () => {
    const listenerRef = { current: null as ((reason: string) => void) | null };
    const workspaceSecurity = security(listenerRef);
    let resolveUnlock!: (status: WorkspaceSecurityStatus) => void;
    const pendingUnlock = new Promise<WorkspaceSecurityStatus>((resolve) => {
      resolveUnlock = resolve;
    });
    vi.mocked(workspaceSecurity.inspect).mockResolvedValue(locked);
    vi.mocked(workspaceSecurity.unlock).mockReturnValueOnce(pendingUnlock);
    await act(async () => {
      root.render(
        <WorkspaceSecurityGate security={workspaceSecurity}>
          {() => <div data-testid="secret-content">secret</div>}
        </WorkspaceSecurityGate>,
      );
    });

    const input = container.querySelector<HTMLInputElement>(
      "#workspace-unlock-password",
    )!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "correct horse battery staple");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      container
        .querySelector<HTMLFormElement>(".security-unlock-form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(workspaceSecurity.unlock).toHaveBeenCalledWith(
      "correct horse battery staple",
    );

    await act(async () => {
      listenerRef.current?.("windows_session_locked");
      await Promise.resolve();
    });
    await act(async () => {
      resolveUnlock(unlocked);
      await pendingUnlock;
    });

    expect(container.querySelector('[data-testid="secret-content"]')).toBeNull();
    expect(container.querySelector("#workspace-unlock-password")).not.toBeNull();
  });
});

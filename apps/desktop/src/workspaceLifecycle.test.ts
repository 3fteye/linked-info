import { describe, expect, it, vi } from "vitest";
import {
  createTauriWorkspaceLifecycle,
  type CloseRequestEvent,
  type CloseWindowBridge,
} from "./workspaceLifecycle";

class MemoryCloseWindow implements CloseWindowBridge {
  handler: ((event: CloseRequestEvent) => void | Promise<void>) | null = null;
  readonly destroy = vi.fn(async () => undefined);

  async onCloseRequested(
    handler: (event: CloseRequestEvent) => void | Promise<void>,
  ): Promise<() => void> {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  async requestClose(event: CloseRequestEvent): Promise<void> {
    await this.handler?.(event);
  }
}

describe("createTauriWorkspaceLifecycle", () => {
  it("flushes the latest workspace before destroying the window", async () => {
    const appWindow = new MemoryCloseWindow();
    const flush = vi.fn(async () => undefined);
    const onFailure = vi.fn();
    const preventDefault = vi.fn();
    const lifecycle = createTauriWorkspaceLifecycle(appWindow);
    await lifecycle.registerCloseFlush(flush, onFailure);

    await appWindow.requestClose({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(appWindow.destroy).toHaveBeenCalledOnce();
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
      appWindow.destroy.mock.invocationCallOrder[0],
    );
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("keeps the window open and reports a failed flush", async () => {
    const appWindow = new MemoryCloseWindow();
    const flush = vi.fn(async () => {
      throw new Error("disk full");
    });
    const onFailure = vi.fn();
    const lifecycle = createTauriWorkspaceLifecycle(appWindow);
    await lifecycle.registerCloseFlush(flush, onFailure);

    await appWindow.requestClose({ preventDefault: vi.fn() });

    expect(appWindow.destroy).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createTauriWorkspaceLifecycle,
  type CloseRequestEvent,
  type CloseApplicationBridge,
} from "./workspaceLifecycle";

class MemoryCloseApplication implements CloseApplicationBridge {
  handler: ((event: CloseRequestEvent) => void | Promise<void>) | null = null;
  readonly exit = vi.fn(async () => undefined);

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
  it("flushes the latest workspace before exiting the application", async () => {
    const application = new MemoryCloseApplication();
    const flush = vi.fn(async () => undefined);
    const onFailure = vi.fn();
    const preventDefault = vi.fn();
    const lifecycle = createTauriWorkspaceLifecycle(application);
    await lifecycle.registerCloseFlush(flush, onFailure);

    await application.requestClose({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(application.exit).toHaveBeenCalledOnce();
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
      application.exit.mock.invocationCallOrder[0],
    );
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("keeps the window open and reports a failed flush", async () => {
    const application = new MemoryCloseApplication();
    const flush = vi.fn(async () => {
      throw new Error("disk full");
    });
    const onFailure = vi.fn();
    const lifecycle = createTauriWorkspaceLifecycle(application);
    await lifecycle.registerCloseFlush(flush, onFailure);

    await application.requestClose({ preventDefault: vi.fn() });

    expect(application.exit).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
  });
});

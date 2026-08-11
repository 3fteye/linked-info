export interface WorkspaceLifecycle {
  registerCloseFlush(
    flush: () => Promise<void>,
    onFailure: () => void,
  ): Promise<() => void>;
}

export interface CloseRequestEvent {
  preventDefault(): void;
}

export interface CloseWindowBridge {
  destroy(): Promise<void>;
  onCloseRequested(
    handler: (event: CloseRequestEvent) => void | Promise<void>,
  ): Promise<() => void>;
}

export function createTauriWorkspaceLifecycle(
  appWindow: CloseWindowBridge,
): WorkspaceLifecycle {
  return {
    registerCloseFlush(flush, onFailure) {
      let closeInProgress = false;
      return appWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        if (closeInProgress) {
          return;
        }

        closeInProgress = true;
        try {
          await flush();
          await appWindow.destroy();
        } catch {
          closeInProgress = false;
          onFailure();
        }
      });
    },
  };
}

export const browserWorkspaceLifecycle: WorkspaceLifecycle = {
  async registerCloseFlush(flush) {
    const flushBeforeUnload = () => {
      void flush();
    };
    window.addEventListener("beforeunload", flushBeforeUnload);
    return () => window.removeEventListener("beforeunload", flushBeforeUnload);
  },
};

export interface WorkspaceLifecycle {
  restart?(): Promise<void>;
  registerCloseFlush(
    flush: () => Promise<void>,
    onFailure: () => void,
  ): Promise<() => void>;
}

export interface CloseRequestEvent {
  preventDefault(): void;
}

export interface CloseApplicationBridge {
  exit(): Promise<void>;
  restart?(): Promise<void>;
  onCloseRequested(
    handler: (event: CloseRequestEvent) => void | Promise<void>,
  ): Promise<() => void>;
}

export function createTauriWorkspaceLifecycle(
  application: CloseApplicationBridge,
): WorkspaceLifecycle {
  const restart = application.restart?.bind(application);
  return {
    ...(restart === undefined ? {} : { restart }),
    registerCloseFlush(flush, onFailure) {
      let closeInProgress = false;
      return application.onCloseRequested(async (event) => {
        event.preventDefault();
        if (closeInProgress) {
          return;
        }

        closeInProgress = true;
        try {
          await flush();
          await application.exit();
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

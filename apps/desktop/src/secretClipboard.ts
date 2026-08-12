import { invoke } from "@tauri-apps/api/core";

export interface SecretClipboardStatus {
  available: boolean;
  clearAfterMs: number;
}

export interface SecretClipboard {
  inspect(): Promise<SecretClipboardStatus>;
  copy(text: string): Promise<SecretClipboardStatus>;
}

export const tauriSecretClipboard: SecretClipboard = {
  inspect() {
    return invoke<SecretClipboardStatus>("inspect_secret_clipboard");
  },
  copy(text) {
    return invoke<SecretClipboardStatus>("copy_secret_to_clipboard", { text });
  },
};

const unavailableStatus: SecretClipboardStatus = {
  available: false,
  clearAfterMs: 0,
};

export const unavailableSecretClipboard: SecretClipboard = {
  async inspect() {
    return unavailableStatus;
  },
  async copy() {
    throw new Error("secret_clipboard_unavailable");
  },
};

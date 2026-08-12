import { invoke, isTauri } from "@tauri-apps/api/core";

export interface ImportedWorkspaceFile {
  name: string;
  text: string;
}

export async function exportWorkspaceFile(
  text: string,
  suggestedName: string,
): Promise<boolean> {
  if (isTauri()) {
    return invoke<boolean>("export_workspace_transfer", {
      suggestedName,
      text,
    });
  }

  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.download = suggestedName;
  link.href = url;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export async function importWorkspaceFile(): Promise<ImportedWorkspaceFile | null> {
  if (isTauri()) {
    return invoke<ImportedWorkspaceFile | null>("import_workspace_transfer");
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.accept = "application/json,.json";
    input.hidden = true;
    input.type = "file";
    let settled = false;

    const finish = (value: ImportedWorkspaceFile | null) => {
      if (settled) {
        return;
      }
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0];
        if (file === undefined) {
          finish(null);
          return;
        }
        void file
          .text()
          .then((text) => finish({ name: file.name, text }))
          .catch(() => finish(null));
      },
      { once: true },
    );
    input.addEventListener("cancel", () => finish(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

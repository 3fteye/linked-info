import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

export interface ImportedWorkspaceFile {
  name: string;
  text: string;
}

const jsonFilter = [{ name: "JSON", extensions: ["json"] }];

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export async function exportWorkspaceFile(
  text: string,
  suggestedName: string,
): Promise<boolean> {
  if (isTauri()) {
    const path = await save({ defaultPath: suggestedName, filters: jsonFilter });
    if (path === null) {
      return false;
    }
    await writeTextFile(path, text);
    return true;
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
    const path = await open({
      directory: false,
      filters: jsonFilter,
      multiple: false,
    });
    if (typeof path !== "string") {
      return null;
    }
    return { name: fileNameFromPath(path), text: await readTextFile(path) };
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

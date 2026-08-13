import { invoke, isTauri } from "@tauri-apps/api/core";

export interface ImportedTextDocument {
  name: string;
  text: string;
}

export async function importTextDocument(): Promise<ImportedTextDocument | null> {
  if (isTauri()) {
    return invoke<ImportedTextDocument | null>("import_text_document");
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.accept = ".txt,.md,.markdown,text/plain,text/markdown";
    input.hidden = true;
    input.type = "file";
    let settled = false;
    const finish = (value: ImportedTextDocument | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file === undefined) return finish(null);
      void file.text().then((text) => finish({ name: file.name, text })).catch(() => finish(null));
    }, { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

export async function importDocumentDraft(): Promise<ImportedTextDocument | null> {
  if (isTauri()) {
    return invoke<ImportedTextDocument | null>("import_document_draft");
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.accept = ".json,application/json";
    input.hidden = true;
    input.type = "file";
    let settled = false;
    const finish = (value: ImportedTextDocument | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file === undefined) return finish(null);
      void file.text().then((text) => finish({ name: file.name, text })).catch(() => finish(null));
    }, { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

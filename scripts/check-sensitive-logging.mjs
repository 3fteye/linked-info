import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const sensitiveSourcePaths = [
  "apps/desktop/src-tauri/src/cloudflare_backup_target.rs",
  "apps/desktop/src-tauri/src/embedding.rs",
  "apps/desktop/src-tauri/src/file_transfer.rs",
  "apps/desktop/src-tauri/src/llm.rs",
  "apps/desktop/src-tauri/src/offsite_backup.rs",
  "apps/desktop/src-tauri/src/s3_backup_target.rs",
  "apps/desktop/src-tauri/src/secret_clipboard.rs",
  "apps/desktop/src-tauri/src/system_unlock.rs",
  "apps/desktop/src-tauri/src/vector_cache.rs",
  "apps/desktop/src-tauri/src/workspace_file.rs",
  "apps/desktop/src/App.tsx",
  "apps/desktop/src/GraphCanvas.tsx",
  "apps/desktop/src/WorkspaceSecurityGate.tsx",
  "apps/desktop/src/DocumentImportDialog.tsx",
  "apps/desktop/src/contentEnhancer.ts",
  "apps/desktop/src/contentProcessor.tsx",
  "apps/desktop/src/documentImport.ts",
  "apps/desktop/src/documentImportBridge.ts",
  "apps/desktop/src/embeddingBridge.ts",
  "apps/desktop/src/llmBridge.ts",
  "apps/desktop/src/offsiteBackup.ts",
  "apps/desktop/src/secretClipboard.ts",
  "apps/desktop/src/totp.ts",
  "apps/desktop/src/totpContent.tsx",
  "apps/desktop/src/workspaceSecurity.ts",
];

const forbiddenLogging = [
  { label: "Rust stdout/stderr/debug macro", pattern: /\b(?:print|println|eprint|eprintln|dbg)!\s*\(/g },
  { label: "Rust logging facade", pattern: /\b(?:log|tracing)::/g },
  { label: "browser console logging", pattern: /\bconsole\.(?:log|debug|info|warn|error)\s*\(/g },
];

export function scanSensitiveSource(source, sourcePath) {
  const violations = [];
  for (const rule of forbiddenLogging) {
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      const line = source.slice(0, match.index).split(/\r?\n/u).length;
      violations.push(`${sourcePath}:${line}: ${rule.label}`);
    }
  }
  return violations;
}

export async function checkSensitiveLoggingBoundary(root = repositoryRoot) {
  const violations = [];
  for (const sourcePath of sensitiveSourcePaths) {
    const source = await readFile(path.join(root, sourcePath), "utf8");
    violations.push(...scanSensitiveSource(source, sourcePath));
  }
  return violations;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const violations = await checkSensitiveLoggingBoundary();
  if (violations.length > 0) {
    process.stderr.write(
      `Sensitive-data modules must not use ordinary logging APIs:\n${violations.join("\n")}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Sensitive logging boundary passed for ${sensitiveSourcePaths.length} source files.\n`,
    );
  }
}

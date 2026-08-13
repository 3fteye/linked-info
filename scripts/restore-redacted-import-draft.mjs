import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const placeholderPattern = /\[\[LI_[A-Z_]+_\d{3}\]\]/gu;

function normalizeNewlines(value) {
  return value.replace(/\r\n?/gu, "\n");
}

export function derivePlaceholderMapping(originalInput, redactedInput) {
  const original = normalizeNewlines(String(originalInput));
  const redacted = normalizeNewlines(String(redactedInput));
  const matches = [...redacted.matchAll(placeholderPattern)];
  placeholderPattern.lastIndex = 0;
  if (matches.length === 0) {
    if (original !== redacted) throw new Error("redacted text has no placeholders but differs");
    return new Map();
  }

  const mapping = new Map();
  let originalCursor = 0;
  let redactedCursor = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const matchIndex = match.index;
    const literalBefore = redacted.slice(redactedCursor, matchIndex);
    if (!original.startsWith(literalBefore, originalCursor)) {
      throw new Error(`redacted alignment failed before placeholder ${index + 1}`);
    }
    originalCursor += literalBefore.length;

    const afterPlaceholder = matchIndex + match[0].length;
    const nextMatchIndex = matches[index + 1]?.index ?? redacted.length;
    const nextLiteral = redacted.slice(afterPlaceholder, nextMatchIndex);
    if (nextLiteral.length === 0 && index + 1 < matches.length) {
      throw new Error(`adjacent placeholders cannot be aligned at position ${index + 1}`);
    }
    const valueEnd = nextLiteral.length
      ? original.indexOf(nextLiteral, originalCursor)
      : original.length;
    if (valueEnd < originalCursor) {
      throw new Error(`redacted alignment failed after placeholder ${index + 1}`);
    }
    const value = original.slice(originalCursor, valueEnd);
    const previous = mapping.get(match[0]);
    if (previous !== undefined && previous !== value) {
      throw new Error(`repeated placeholder has conflicting local values at position ${index + 1}`);
    }
    mapping.set(match[0], value);
    originalCursor = valueEnd;
    redactedCursor = afterPlaceholder;
  }

  const tail = redacted.slice(redactedCursor);
  if (!original.startsWith(tail, originalCursor) || originalCursor + tail.length !== original.length) {
    throw new Error("redacted alignment failed at document tail");
  }
  return mapping;
}

function restoreString(value, mapping) {
  return value.replace(placeholderPattern, (placeholder) => {
    const replacement = mapping.get(placeholder);
    if (replacement === undefined) {
      throw new Error("draft contains a placeholder absent from the redacted source");
    }
    return replacement;
  });
}

function restoreValue(value, mapping) {
  if (typeof value === "string") return restoreString(value, mapping);
  if (Array.isArray(value)) return value.map((child) => restoreValue(child, mapping));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        restoreString(key, mapping),
        restoreValue(child, mapping),
      ]),
    );
  }
  return value;
}

export function restoreImportDraft(originalInput, redactedInput, draftInput) {
  const original = normalizeNewlines(String(originalInput)).trim();
  const redacted = normalizeNewlines(String(redactedInput)).trim();
  const mapping = derivePlaceholderMapping(original, redacted);
  const draft = JSON.parse(String(draftInput));
  const restored = restoreValue(draft, mapping);
  if (restored.sourceText !== original) {
    throw new Error("restored draft source does not exactly match the local original");
  }
  const serialized = `${JSON.stringify(restored, null, 2)}\n`;
  placeholderPattern.lastIndex = 0;
  if (placeholderPattern.test(serialized)) {
    placeholderPattern.lastIndex = 0;
    throw new Error("restored draft still contains placeholders");
  }
  restored.sourceHash = createHash("sha256").update(original, "utf8").digest("hex");
  if (restored.handling && typeof restored.handling === "object") {
    restored.handling.secretsRemainAsLocalPlaceholders = false;
    restored.handling.restoredLocally = true;
  }
  return {
    text: `${JSON.stringify(restored, null, 2)}\n`,
    mappingCount: mapping.size,
    sourceHash: restored.sourceHash,
  };
}

async function main() {
  const [, , originalArgument, redactedArgument, draftArgument, outputArgument] = process.argv;
  if (!originalArgument || !redactedArgument || !draftArgument || !outputArgument) {
    throw new Error(
      "usage: node scripts/restore-redacted-import-draft.mjs <original.txt> <redacted.txt> <redacted-draft.json> <restored-draft.json>",
    );
  }
  const [original, redacted, draft] = await Promise.all([
    readFile(resolve(originalArgument), "utf8"),
    readFile(resolve(redactedArgument), "utf8"),
    readFile(resolve(draftArgument), "utf8"),
  ]);
  const result = restoreImportDraft(original, redacted, draft);
  const outputPath = resolve(outputArgument);
  const temporaryPath = `${outputPath}.tmp`;
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(temporaryPath, { force: true });
  await writeFile(temporaryPath, result.text, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, outputPath);
  process.stdout.write(
    `${JSON.stringify({
      outputPath,
      mappingCount: result.mappingCount,
      sourceHash: result.sourceHash,
      exactSourceMatch: true,
      placeholdersRemaining: 0,
    }, null, 2)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

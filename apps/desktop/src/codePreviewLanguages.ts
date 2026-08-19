export const codePreviewLanguages = [
  "powershell",
  "bash",
  "python",
  "javascript",
  "typescript",
  "rust",
  "json",
  "yaml",
  "sql",
] as const;

export type CodePreviewLanguage = (typeof codePreviewLanguages)[number];

export type CodeContentProcessorId = `code.${CodePreviewLanguage}`;

export function codeContentProcessorId(
  language: CodePreviewLanguage,
): CodeContentProcessorId {
  return `code.${language}`;
}

const codePreviewLanguageSet = new Set<string>(codePreviewLanguages);

export function asCodePreviewLanguage(
  language: string,
): CodePreviewLanguage | null {
  return codePreviewLanguageSet.has(language)
    ? (language as CodePreviewLanguage)
    : null;
}

export function codePreviewLanguageFromProcessorId(
  processorId: string,
): CodePreviewLanguage | null {
  if (!processorId.startsWith("code.")) {
    return null;
  }
  const language = processorId.slice("code.".length);
  return asCodePreviewLanguage(language);
}

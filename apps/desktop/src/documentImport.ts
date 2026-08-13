import { normalizeNodeName, type WorkspaceSnapshot } from "./workspaceData";
import type { LocalLlmModelId } from "./localLlmModels";

export const maximumDocumentImportCharacters = 120_000;
export const maximumDocumentImportChunks = 64;
export const externalDocumentImportKind = "linked-info-document-import-draft";
const maximumChunkCharacters = 1_800;
const chunkOverlapCharacters = 160;
const maximumCandidateContentCharacters = 6_000;
const maximumExternalDraftCandidates = maximumDocumentImportChunks * 24;

export interface DocumentImportChunkRequest {
  sourceName: string;
  chunkIndex: number;
  chunkCount: number;
  text: string;
}

export interface DocumentImportCandidateOutput {
  name: string;
  content: string | null;
  referenceNames: string[];
}

export interface DocumentImportChunkResponse {
  nodes: DocumentImportCandidateOutput[];
}

export interface DocumentImportLlmGateway {
  extractChunk(
    modelId: LocalLlmModelId,
    request: DocumentImportChunkRequest,
  ): Promise<DocumentImportChunkResponse>;
}

export interface DocumentImportCandidate {
  id: string;
  name: string;
  content: string | null;
  referenceNames: string[];
  matchedNodeId: string | null;
  selected: boolean;
}

export interface DocumentImportDraft {
  sourceNodeId: string;
  sourceName: string;
  sourceText: string;
  sourceHash: string;
  importedAtMs: number;
  modelId: LocalLlmModelId | "external";
  candidates: DocumentImportCandidate[];
}

export interface ExternalDocumentImportFile {
  sourceName: string;
  sourceText: string;
  responses: DocumentImportChunkResponse[];
}

export interface DocumentImportBuildResult {
  workspace: WorkspaceSnapshot;
  addedNodeCount: number;
  matchedNodeCount: number;
  addedReferenceCount: number;
}

function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function sliceLongParagraph(paragraph: string): string[] {
  const characters = Array.from(paragraph);
  if (characters.length <= maximumChunkCharacters) return [paragraph];
  const step = maximumChunkCharacters - chunkOverlapCharacters;
  const result: string[] = [];
  for (let start = 0; start < characters.length; start += step) {
    result.push(characters.slice(start, start + maximumChunkCharacters).join(""));
    if (start + maximumChunkCharacters >= characters.length) break;
  }
  return result;
}

export function splitDocumentForImport(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) return [];
  if (Array.from(normalized).length > maximumDocumentImportCharacters) {
    throw new Error("documentImportTooLarge");
  }

  const units = paragraphs(normalized).flatMap(sliceLongParagraph);
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    const combined = current.length === 0 ? unit : `${current}\n\n${unit}`;
    if (Array.from(combined).length <= maximumChunkCharacters) {
      current = combined;
      continue;
    }
    if (current.length > 0) chunks.push(current);
    current = unit;
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length > maximumDocumentImportChunks) {
    throw new Error("documentImportTooManyChunks");
  }
  return chunks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidExternalDraft(): never {
  throw new Error("documentImportInvalidExternalDraft");
}

export function parseExternalDocumentImportFile(text: string): ExternalDocumentImportFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalidExternalDraft();
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== externalDocumentImportKind ||
    typeof value.sourceName !== "string" ||
    value.sourceName.trim().length === 0 ||
    Array.from(value.sourceName).length > 240 ||
    typeof value.sourceText !== "string" ||
    value.sourceText.trim().length === 0 ||
    Array.from(value.sourceText).length > maximumDocumentImportCharacters ||
    !Array.isArray(value.responses) ||
    value.responses.length === 0 ||
    value.responses.length > maximumDocumentImportChunks
  ) {
    return invalidExternalDraft();
  }

  let candidateCount = 0;
  const responses: DocumentImportChunkResponse[] = value.responses.map((response) => {
    if (!isRecord(response) || !Array.isArray(response.nodes) || response.nodes.length > 24) {
      return invalidExternalDraft();
    }
    candidateCount += response.nodes.length;
    const nodes = response.nodes.map((node): DocumentImportCandidateOutput => {
      if (
        !isRecord(node) ||
        typeof node.name !== "string" ||
        node.name.trim().length === 0 ||
        Array.from(node.name).length > 160 ||
        (node.content !== null && typeof node.content !== "string") ||
        (typeof node.content === "string" &&
          Array.from(node.content).length > maximumCandidateContentCharacters) ||
        !Array.isArray(node.referenceNames) ||
        node.referenceNames.length > 12 ||
        node.referenceNames.some(
          (referenceName) =>
            typeof referenceName !== "string" ||
            referenceName.trim().length === 0 ||
            Array.from(referenceName).length > 160,
        )
      ) {
        return invalidExternalDraft();
      }
      return {
        name: node.name,
        content: node.content as string | null,
        referenceNames: node.referenceNames as string[],
      };
    });
    return { nodes };
  });
  if (candidateCount === 0 || candidateCount > maximumExternalDraftCandidates) {
    return invalidExternalDraft();
  }
  return {
    sourceName: value.sourceName.trim(),
    sourceText: value.sourceText,
    responses,
  };
}

export function validateExternalDocumentImportReferences(
  candidates: DocumentImportCandidate[],
  workspace: WorkspaceSnapshot,
): void {
  const availableNames = new Set(
    [
      ...workspace.nodes.map((node) => node.name),
      ...candidates.map((candidate) => candidate.name),
    ]
      .filter((name): name is string => name !== null)
      .map(normalizeNodeName),
  );
  if (
    candidates.some((candidate) =>
      candidate.referenceNames.some(
        (referenceName) => !availableNames.has(normalizeNodeName(referenceName)),
      ),
    )
  ) {
    invalidExternalDraft();
  }
}

export function validateExternalDocumentImportIsRestored(
  external: ExternalDocumentImportFile,
): void {
  const placeholderPattern = /\[\[LI_[A-Z_]+_\d{3}\]\]/u;
  if (
    placeholderPattern.test(external.sourceText) ||
    external.responses.some((response) =>
      response.nodes.some(
        (node) =>
          placeholderPattern.test(node.name) ||
          (node.content !== null && placeholderPattern.test(node.content)) ||
          node.referenceNames.some((referenceName) => placeholderPattern.test(referenceName)),
      ),
    )
  ) {
    throw new Error("documentImportContainsPlaceholders");
  }
}

function mergeContent(left: string | null, right: string | null): string | null {
  const values = [left, right]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0);
  if (values.length === 0) return null;
  let merged: string;
  if (values.length === 1 || values[0] === values[1]) merged = values[0];
  else if (values[0].includes(values[1])) merged = values[0];
  else if (values[1].includes(values[0])) merged = values[1];
  else merged = `${values[0]}\n\n${values[1]}`;
  return Array.from(merged).slice(0, maximumCandidateContentCharacters).join("");
}

export function mergeDocumentImportCandidates(
  responses: DocumentImportChunkResponse[],
  workspace: WorkspaceSnapshot,
): DocumentImportCandidate[] {
  const existingByName = new Map(
    workspace.nodes
      .filter((node) => node.name !== null)
      .map((node) => [normalizeNodeName(node.name ?? ""), node.id]),
  );
  const merged = new Map<string, DocumentImportCandidate>();
  for (const response of responses) {
    for (const output of response.nodes) {
      const name = output.name.trim();
      const key = normalizeNodeName(name);
      if (key.length === 0) continue;
      const referenceNames = output.referenceNames
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && normalizeNodeName(value) !== key);
      const current = merged.get(key);
      if (current === undefined) {
        merged.set(key, {
          id: crypto.randomUUID(),
          name,
          content: output.content?.trim() || null,
          referenceNames: [...new Set(referenceNames)],
          matchedNodeId: existingByName.get(key) ?? null,
          selected: true,
        });
      } else {
        current.content = mergeContent(current.content, output.content);
        current.referenceNames = [
          ...new Set([...current.referenceNames, ...referenceNames]),
        ].slice(0, 12);
      }
    }
  }
  return [...merged.values()];
}

function uniqueSourceName(
  workspace: WorkspaceSnapshot,
  sourceName: string,
  reservedNames: ReadonlySet<string>,
): string {
  const base = `来源：${sourceName.trim() || "粘贴文本"}`;
  const names = new Set(
    workspace.nodes
      .map((node) => node.name)
      .filter((name): name is string => name !== null)
      .map(normalizeNodeName),
  );
  reservedNames.forEach((name) => names.add(name));
  if (!names.has(normalizeNodeName(base))) return base;
  let suffix = 2;
  while (names.has(normalizeNodeName(`${base} (${suffix})`))) suffix += 1;
  return `${base} (${suffix})`;
}

function referenceKey(sourceNodeId: string, targetNodeId: string): string {
  return `${sourceNodeId}\0${targetNodeId}`;
}

export function buildDocumentImportWorkspace(
  base: WorkspaceSnapshot,
  draft: DocumentImportDraft,
): DocumentImportBuildResult {
  const selected = draft.candidates.filter((candidate) => candidate.selected);
  const sourceNodeId = draft.sourceNodeId;
  const existingNodeIds = new Set(base.nodes.map((node) => node.id));
  if (existingNodeIds.has(sourceNodeId)) {
    throw new Error("documentImportInvalidDraft");
  }
  const existingByName = new Map(
    base.nodes
      .filter((node) => node.name !== null)
      .map((node) => [normalizeNodeName(node.name ?? ""), node.id]),
  );
  const selectedNames = new Set<string>();
  const resolved = selected.map((candidate) => {
    const name = candidate.name.trim();
    const normalizedName = normalizeNodeName(name);
    if (
      normalizedName.length === 0 ||
      Array.from(name).length > 160 ||
      (candidate.content !== null &&
        Array.from(candidate.content).length > maximumCandidateContentCharacters) ||
      candidate.referenceNames.length > 12 ||
      candidate.referenceNames.some(
        (referenceName) =>
          referenceName.trim().length === 0 || Array.from(referenceName).length > 160,
      ) ||
      selectedNames.has(normalizedName) ||
      existingNodeIds.has(candidate.id)
    ) {
      throw new Error("documentImportNameConflict");
    }
    selectedNames.add(normalizedName);
    return {
      candidate,
      matchedNodeId: existingByName.get(normalizedName) ?? null,
    };
  });
  const sourceBaseName = normalizeNodeName(
    `来源：${draft.sourceName.trim() || "粘贴文本"}`,
  );
  if (selectedNames.has(sourceBaseName)) {
    throw new Error("documentImportNameConflict");
  }
  const sourceName = uniqueSourceName(base, draft.sourceName, selectedNames);
  const sourceContent = [
    `导入时间：${new Date(draft.importedAtMs).toISOString()}`,
    `原始来源：${draft.sourceName}`,
    `SHA-256：${draft.sourceHash}`,
    `分析方式：${draft.modelId === "external" ? "外部分析草稿" : `本地模型 ${draft.modelId}`}`,
    "",
    "--- 原始内容 ---",
    draft.sourceText,
  ].join("\n");
  const newCandidates = resolved.filter((item) => item.matchedNodeId === null);
  const nodes = [
    ...base.nodes,
    { id: sourceNodeId, name: sourceName, content: sourceContent },
    ...newCandidates.map(({ candidate }) => ({
      id: candidate.id,
      name: candidate.name.trim(),
      content: candidate.content?.trim() || null,
    })),
  ];

  const maximumX = base.layout.reduce((value, item) => Math.max(value, item.x), 0);
  const startX = base.layout.length === 0 ? 80 : maximumX + 360;
  const layout = [
    ...base.layout,
    { nodeId: sourceNodeId, x: startX, y: 80 },
    ...newCandidates.map(({ candidate }, index) => ({
      nodeId: candidate.id,
      x: startX + 340 + (index % 3) * 300,
      y: 80 + Math.floor(index / 3) * 220,
    })),
  ];

  const actualNodeIdByName = new Map<string, string>();
  for (const node of nodes) {
    if (node.name !== null) actualNodeIdByName.set(normalizeNodeName(node.name), node.id);
  }
  const references = [...base.references];
  const referenceKeys = new Set(
    references.map((item) => referenceKey(item.sourceNodeId, item.targetNodeId)),
  );
  const appendReference = (sourceNodeId: string, targetNodeId: string) => {
    if (sourceNodeId === targetNodeId) return;
    const key = referenceKey(sourceNodeId, targetNodeId);
    if (referenceKeys.has(key)) return;
    referenceKeys.add(key);
    references.push({ sourceNodeId, targetNodeId });
  };
  for (const { candidate, matchedNodeId } of resolved) {
    const sourceId = matchedNodeId ?? candidate.id;
    appendReference(sourceId, sourceNodeId);
    for (const referenceName of candidate.referenceNames) {
      const targetId = actualNodeIdByName.get(normalizeNodeName(referenceName));
      if (targetId !== undefined) appendReference(sourceId, targetId);
    }
  }

  return {
    workspace: {
      ...base,
      nodes,
      layout,
      references,
    },
    addedNodeCount: newCandidates.length + 1,
    matchedNodeCount: resolved.length - newCandidates.length,
    addedReferenceCount: references.length - base.references.length,
  };
}

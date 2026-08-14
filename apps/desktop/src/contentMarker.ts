export interface ContentMarkerDefinition {
  excludeFromSemanticAnalysis: boolean;
  id: string;
}

export interface ParsedContentMarker {
  definition: ContentMarkerDefinition | null;
  id: string;
  payload: string;
  raw: string;
}

export type ContentMarkerSegment =
  | { kind: "marker"; marker: ParsedContentMarker }
  | { kind: "text"; text: string };

export interface WrappedContentSelection {
  caret: number;
  content: string;
}

const markerOpeningPattern = /\[\[li:([a-z][a-z0-9-]*)\]\]/gu;
const markerClosing = "[[/li]]";
const markerIdPattern = /^[a-z][a-z0-9-]*$/u;

function appendText(segments: ContentMarkerSegment[], text: string) {
  if (text.length === 0) {
    return;
  }
  const previous = segments[segments.length - 1];
  if (previous?.kind === "text") {
    previous.text += text;
  } else {
    segments.push({ kind: "text", text });
  }
}

function escapedPayload(payload: string): string {
  return payload
    .replace(/\\/gu, "\\\\")
    .split(markerClosing)
    .join(`\\${markerClosing}`);
}

function decodedPayload(payload: string): string {
  let result = "";
  for (let index = 0; index < payload.length; index += 1) {
    if (payload[index] !== "\\") {
      result += payload[index];
      continue;
    }
    if (payload[index + 1] === "\\") {
      result += "\\";
      index += 1;
      continue;
    }
    if (payload.startsWith(markerClosing, index + 1)) {
      result += markerClosing;
      index += markerClosing.length;
      continue;
    }
    result += "\\";
  }
  return result;
}

function closingMarkerIndex(source: string, payloadStart: number): number | null {
  for (let index = payloadStart; index < source.length; index += 1) {
    if (source[index] === "\\") {
      if (source[index + 1] === "\\") {
        index += 1;
        continue;
      }
      if (source.startsWith(markerClosing, index + 1)) {
        index += markerClosing.length;
        continue;
      }
    }
    if (source.startsWith(markerClosing, index)) {
      return index;
    }
  }
  return null;
}

export class ContentMarkerRegistry {
  private readonly definitions: ReadonlyMap<string, ContentMarkerDefinition>;

  constructor(definitions: readonly ContentMarkerDefinition[]) {
    const byId = new Map<string, ContentMarkerDefinition>();
    for (const definition of definitions) {
      if (!markerIdPattern.test(definition.id)) {
        throw new Error(`invalid content marker id: ${definition.id}`);
      }
      if (byId.has(definition.id)) {
        throw new Error(`duplicate content marker id: ${definition.id}`);
      }
      byId.set(definition.id, definition);
    }
    this.definitions = byId;
  }

  get(id: string): ContentMarkerDefinition | null {
    return this.definitions.get(id) ?? null;
  }

  list(): readonly ContentMarkerDefinition[] {
    return Array.from(this.definitions.values());
  }

  segment(source: string): ContentMarkerSegment[] {
    const segments: ContentMarkerSegment[] = [];
    let cursor = 0;
    markerOpeningPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = markerOpeningPattern.exec(source)) !== null) {
      const openingStart = match.index;
      const payloadStart = openingStart + match[0].length;
      const closingStart = closingMarkerIndex(source, payloadStart);
      if (closingStart === null) {
        break;
      }
      appendText(segments, source.slice(cursor, openingStart));
      const end = closingStart + markerClosing.length;
      const id = match[1];
      segments.push({
        kind: "marker",
        marker: {
          definition: this.get(id),
          id,
          payload: decodedPayload(source.slice(payloadStart, closingStart)),
          raw: source.slice(openingStart, end),
        },
      });
      cursor = end;
      markerOpeningPattern.lastIndex = end;
    }
    appendText(segments, source.slice(cursor));
    return segments;
  }

  serialize(id: string, payload: string): string {
    if (!this.definitions.has(id)) {
      throw new Error(`unknown content marker id: ${id}`);
    }
    return `[[li:${id}]]${escapedPayload(payload)}${markerClosing}`;
  }

  wrapSelection(
    content: string,
    selectionStart: number,
    selectionEnd: number,
    id: string,
  ): WrappedContentSelection {
    if (
      !Number.isSafeInteger(selectionStart) ||
      !Number.isSafeInteger(selectionEnd) ||
      selectionStart < 0 ||
      selectionEnd <= selectionStart ||
      selectionEnd > content.length
    ) {
      throw new Error("invalid content marker selection");
    }
    const marker = this.serialize(id, content.slice(selectionStart, selectionEnd));
    return {
      caret: selectionStart + marker.length,
      content: `${content.slice(0, selectionStart)}${marker}${content.slice(selectionEnd)}`,
    };
  }
}

export const contentMarkerRegistry = new ContentMarkerRegistry([
  { excludeFromSemanticAnalysis: true, id: "totp" },
  { excludeFromSemanticAnalysis: true, id: "secret" },
]);

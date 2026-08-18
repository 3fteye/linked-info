import { parseTotpPayload } from "./totp";

export interface ContentMarkerDefinition {
  excludeFromSemanticAnalysis: boolean;
  id: string;
  validatePayload?: (payload: string) => boolean;
}

export interface ParsedContentMarker {
  attributes: Readonly<Record<string, string>>;
  definition: ContentMarkerDefinition | null;
  id: string;
  malformed: boolean;
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

export interface LocatedContentMarker {
  end: number;
  marker: ParsedContentMarker;
  payloadEnd: number;
  payloadStart: number;
  start: number;
}

export type ContentMarkerSelection =
  | {
      end: number;
      kind: "conflict";
      start: number;
    }
  | {
      kind: "marker";
      located: LocatedContentMarker;
    }
  | {
      end: number;
      kind: "plain";
      payload: string;
      start: number;
    };

export type ContentMarkerMutationResult =
  | {
      caret: number;
      content: string;
      ok: true;
    }
  | {
      markerId?: string;
      ok: false;
      reason: "conflict" | "invalid-payload" | "not-marker" | "selection-required";
    };

export const CONTENT_MARKER_NOTE_MAX_LENGTH = 160;

const markerOpeningPrefix = "[[li:";
const markerClosing = "[[/li]]";
const markerIdPattern = /^[a-z][a-z0-9-]*$/u;
const markerIdCharacterPattern = /[a-z0-9-]/u;
const markerAttributeNamePattern = /^[a-z][a-z0-9-]*$/u;

interface ParsedMarkerOpening {
  attributes: Record<string, string>;
  end: number;
  id: string;
  malformed: boolean;
}

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

function quotedAttributeEnd(source: string, start: number): number | null {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === '"') {
      return index + 1;
    }
    if (source[index] === "\r" || source[index] === "\n") {
      return null;
    }
  }
  return null;
}

function malformedOpeningEnd(source: string, start: number): number | null {
  const closing = source.indexOf("]]", start);
  return closing < 0 ? null : closing + 2;
}

function parseMarkerOpening(source: string, start: number): ParsedMarkerOpening | null {
  if (!source.startsWith(markerOpeningPrefix, start)) {
    return null;
  }
  const idStart = start + markerOpeningPrefix.length;
  let cursor = idStart;
  while (cursor < source.length && markerIdCharacterPattern.test(source[cursor])) {
    cursor += 1;
  }
  const id = source.slice(idStart, cursor);
  if (!markerIdPattern.test(id)) {
    return null;
  }

  const malformed = (): ParsedMarkerOpening | null => {
    const end = malformedOpeningEnd(source, cursor);
    return end === null ? null : { attributes: {}, end, id, malformed: true };
  };
  const attributes: Record<string, string> = {};
  while (cursor < source.length) {
    if (source.startsWith("]]", cursor)) {
      return { attributes, end: cursor + 2, id, malformed: false };
    }
    if (source[cursor] !== " ") {
      return malformed();
    }
    while (source[cursor] === " ") {
      cursor += 1;
    }
    const nameStart = cursor;
    while (cursor < source.length && markerIdCharacterPattern.test(source[cursor])) {
      cursor += 1;
    }
    const name = source.slice(nameStart, cursor);
    if (!markerAttributeNamePattern.test(name) || source[cursor] !== "=") {
      return malformed();
    }
    cursor += 1;
    if (source[cursor] !== '"') {
      return malformed();
    }
    const valueEnd = quotedAttributeEnd(source, cursor);
    if (valueEnd === null) {
      return malformed();
    }
    let value: unknown;
    try {
      value = JSON.parse(source.slice(cursor, valueEnd));
    } catch {
      return malformed();
    }
    if (
      typeof value !== "string" ||
      Object.prototype.hasOwnProperty.call(attributes, name)
    ) {
      return malformed();
    }
    attributes[name] = value;
    cursor = valueEnd;
  }
  return null;
}

function serializedAttributes(attributes: Readonly<Record<string, string>>): string {
  return Object.entries(attributes)
    .filter(([, value]) => value.length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (!markerAttributeNamePattern.test(name)) {
        throw new Error(`invalid content marker attribute: ${name}`);
      }
      if (name === "note") {
        if (value.includes("\r") || value.includes("\n")) {
          throw new Error("content marker note must be one line");
        }
        if ([...value].length > CONTENT_MARKER_NOTE_MAX_LENGTH) {
          throw new Error("content marker note is too long");
        }
      }
      return ` ${name}=${JSON.stringify(value)}`;
    })
    .join("");
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

function locateContentMarkers(
  source: string,
  definitionFor: (id: string) => ContentMarkerDefinition | null,
): LocatedContentMarker[] {
  const markers: LocatedContentMarker[] = [];
  let searchStart = 0;
  while (searchStart < source.length) {
    const start = source.indexOf(markerOpeningPrefix, searchStart);
    if (start < 0) {
      break;
    }
    const opening = parseMarkerOpening(source, start);
    if (opening === null) {
      searchStart = start + markerOpeningPrefix.length;
      continue;
    }
    const definition = definitionFor(opening.id);
    if (
      opening.malformed &&
      (definition === null || !definition.excludeFromSemanticAnalysis)
    ) {
      searchStart = opening.end;
      continue;
    }
    const payloadStart = opening.end;
    const payloadEnd = closingMarkerIndex(source, payloadStart);
    if (payloadEnd === null) {
      searchStart = opening.end;
      continue;
    }
    const end = payloadEnd + markerClosing.length;
    markers.push({
      end,
      marker: {
        attributes: opening.attributes,
        definition,
        id: opening.id,
        malformed: opening.malformed,
        payload: decodedPayload(source.slice(payloadStart, payloadEnd)),
        raw: source.slice(start, end),
      },
      payloadEnd,
      payloadStart,
      start,
    });
    searchStart = end;
  }
  return markers;
}

function validSelectionRange(source: string, start: number, end: number): boolean {
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end >= start &&
    end <= source.length
  );
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
    for (const located of locateContentMarkers(source, (id) => this.get(id))) {
      appendText(segments, source.slice(cursor, located.start));
      segments.push({
        kind: "marker",
        marker: located.marker,
      });
      cursor = located.end;
    }
    appendText(segments, source.slice(cursor));
    return segments;
  }

  inspectSelection(
    source: string,
    selectionStart: number,
    selectionEnd: number,
  ): ContentMarkerSelection | null {
    if (!validSelectionRange(source, selectionStart, selectionEnd)) {
      throw new Error("invalid content marker selection");
    }
    const markers = locateContentMarkers(source, (id) => this.get(id));
    if (selectionStart === selectionEnd) {
      const located = markers.find(
        (candidate) =>
          candidate.start < selectionStart && selectionStart < candidate.end,
      );
      return located === undefined ? null : { kind: "marker", located };
    }

    const overlapping = markers.filter(
      (candidate) =>
        selectionStart < candidate.end && selectionEnd > candidate.start,
    );
    if (overlapping.length === 0) {
      return {
        end: selectionEnd,
        kind: "plain",
        payload: source.slice(selectionStart, selectionEnd),
        start: selectionStart,
      };
    }
    if (
      overlapping.length === 1 &&
      selectionStart >= overlapping[0].start &&
      selectionEnd <= overlapping[0].end
    ) {
      return { kind: "marker", located: overlapping[0] };
    }
    return {
      end: selectionEnd,
      kind: "conflict",
      start: selectionStart,
    };
  }

  serialize(
    id: string,
    payload: string,
    attributes: Readonly<Record<string, string>> = {},
  ): string {
    if (!this.definitions.has(id)) {
      throw new Error(`unknown content marker id: ${id}`);
    }
    return `[[li:${id}${serializedAttributes(attributes)}]]${escapedPayload(payload)}${markerClosing}`;
  }

  applyMarker(
    content: string,
    selectionStart: number,
    selectionEnd: number,
    id: string,
    attributes?: Readonly<Record<string, string>>,
  ): ContentMarkerMutationResult {
    const definition = this.get(id);
    if (definition === null) {
      throw new Error(`unknown content marker id: ${id}`);
    }
    const selection = this.inspectSelection(
      content,
      selectionStart,
      selectionEnd,
    );
    if (selection === null) {
      return { ok: false, reason: "selection-required" };
    }
    if (selection.kind === "conflict") {
      return { ok: false, reason: "conflict" };
    }
    const payload =
      selection.kind === "marker" ? selection.located.marker.payload : selection.payload;
    if (definition.validatePayload?.(payload) === false) {
      return { markerId: id, ok: false, reason: "invalid-payload" };
    }
    const start =
      selection.kind === "marker" ? selection.located.start : selection.start;
    const end = selection.kind === "marker" ? selection.located.end : selection.end;
    const marker = this.serialize(
      id,
      payload,
      attributes ??
        (selection.kind === "marker" ? selection.located.marker.attributes : {}),
    );
    return {
      caret: start + marker.length,
      content: `${content.slice(0, start)}${marker}${content.slice(end)}`,
      ok: true,
    };
  }

  removeMarker(
    content: string,
    selectionStart: number,
    selectionEnd: number,
  ): ContentMarkerMutationResult {
    const selection = this.inspectSelection(
      content,
      selectionStart,
      selectionEnd,
    );
    if (selection?.kind === "conflict") {
      return { ok: false, reason: "conflict" };
    }
    if (selection?.kind !== "marker") {
      return { ok: false, reason: "not-marker" };
    }
    const { located } = selection;
    const note = located.marker.attributes.note?.trim() ?? "";
    const plainText =
      note.length > 0 ? `${note}: ${located.marker.payload}` : located.marker.payload;
    return {
      caret: located.start + plainText.length,
      content: `${content.slice(0, located.start)}${plainText}${content.slice(located.end)}`,
      ok: true,
    };
  }

  wrapSelection(
    content: string,
    selectionStart: number,
    selectionEnd: number,
    id: string,
    attributes: Readonly<Record<string, string>> = {},
  ): WrappedContentSelection {
    const result = this.applyMarker(
      content,
      selectionStart,
      selectionEnd,
      id,
      attributes,
    );
    if (!result.ok) {
      throw new Error(`invalid content marker selection: ${result.reason}`);
    }
    return result;
  }
}

export const contentMarkerRegistry = new ContentMarkerRegistry([
  {
    excludeFromSemanticAnalysis: true,
    id: "totp",
    validatePayload: (payload) => parseTotpPayload(payload) !== null,
  },
  { excludeFromSemanticAnalysis: true, id: "secret" },
]);

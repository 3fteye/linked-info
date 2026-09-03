export interface InformationNode {
  id: string;
  name: string | null;
  content: string | null;
}

export interface NodeLayout {
  height?: number;
  nodeId: string;
  width?: number;
  x: number;
  y: number;
}

export const minimumManualNodeWidth = 220;
export const minimumManualNodeHeight = 92;
export const maximumManualNodeDimension = 5_000;

export interface NodeReference {
  sourceNodeId: string;
  targetNodeId: string;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface WorkspaceCanvas {
  id: string;
  name: string;
  layout: NodeLayout[];
  viewport: CanvasViewport | null;
}

export interface CanvasBookmark {
  id: string;
  name: string;
  canvasId: string;
  x: number;
  y: number;
  zoom: number;
}

export interface WorkspaceTimelineDay {
  date: string;
  nodeId: string;
}

export interface WorkspaceTimelineCapture {
  nodeId: string;
  capturedAtMs: number;
  utcOffsetMinutes: number;
  day: string;
}

export interface WorkspaceTimeline {
  canvasId: string;
  days: WorkspaceTimelineDay[];
  captures: WorkspaceTimelineCapture[];
}

export const defaultCanvasId = "00000000-0000-4000-8000-000000000001";
export const defaultCanvasName = "Main";

export interface WorkspaceViewMetadata {
  activeCanvasId: string;
  canvases: WorkspaceCanvas[];
  contentProcessorByNodeId: Record<string, string>;
  extensionMetadata: Record<string, WorkspaceExtensionMetadata>;
  bookmarks?: CanvasBookmark[];
  timeline?: WorkspaceTimeline | null;
}

export type ExtensionMetadataJsonValue =
  | null
  | boolean
  | number
  | string
  | ExtensionMetadataJsonValue[]
  | { [key: string]: ExtensionMetadataJsonValue };

export type ExtensionMetadataPayload = Record<
  string,
  ExtensionMetadataJsonValue
>;

export interface WorkspaceExtensionMetadata {
  schemaVersion: number;
  workspace: ExtensionMetadataPayload;
  byNodeId: Record<string, ExtensionMetadataPayload>;
}

export interface WorkspaceSnapshot {
  nodes: InformationNode[];
  references: NodeReference[];
  view: WorkspaceViewMetadata;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const contentProcessorIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const extensionIdPattern =
  /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z](?:[a-z0-9-]*[a-z0-9])?){2,}$/;
const extensionMetadataPropertyPattern = /^[A-Za-z0-9_-]{1,64}$/;
const maximumExtensionCount = 256;
const maximumExtensionMetadataDepth = 16;
const maximumExtensionMetadataObjectProperties = 128;
const maximumExtensionMetadataArrayItems = 1_024;
const maximumExtensionMetadataStringCharacters = 4_096;
const maximumNodeExtensionMetadataBytes = 16 * 1024;
const maximumWorkspaceExtensionMetadataBytes = 64 * 1024;
const maximumSingleExtensionMetadataBytes = 4 * 1024 * 1024;
const maximumTotalExtensionMetadataBytes = 16 * 1024 * 1024;
export const maximumWorkspaceCanvasCount = 256;
export const maximumCanvasBookmarkCount = 4_096;
const maximumCanvasNameCharacters = 128;
const maximumCanvasBookmarkNameCharacters = 128;
const maximumTotalCanvasPlacements = 1_000_000;
const extensionMetadataUtf8Encoder = new TextEncoder();
const invalidExtensionMetadataValue = Symbol("invalidExtensionMetadataValue");
type WorkspaceSnapshotVersion = 1 | 2 | 3 | 4 | 5 | 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function canonicalNodeId(value: unknown): string | null {
  return typeof value === "string" && uuidPattern.test(value)
    ? value.toLowerCase()
    : null;
}

function utf8JsonSize(value: unknown): number {
  return extensionMetadataUtf8Encoder.encode(JSON.stringify(value)).byteLength;
}

function hasValidExtensionMetadataString(value: string): boolean {
  let characterCount = 0;
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0);
    characterCount += 1;
    if (
      codePoint === undefined ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      characterCount > maximumExtensionMetadataStringCharacters
    ) {
      return false;
    }
  }
  return true;
}

function parseExtensionMetadataJsonValue(
  value: unknown,
  depth: number,
): ExtensionMetadataJsonValue | typeof invalidExtensionMetadataValue {
  if (depth > maximumExtensionMetadataDepth) {
    return invalidExtensionMetadataValue;
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
      ? value
      : invalidExtensionMetadataValue;
  }
  if (typeof value === "string") {
    return hasValidExtensionMetadataString(value)
      ? value
      : invalidExtensionMetadataValue;
  }
  if (Array.isArray(value)) {
    if (value.length > maximumExtensionMetadataArrayItems) {
      return invalidExtensionMetadataValue;
    }
    const parsed: ExtensionMetadataJsonValue[] = [];
    for (const item of value) {
      const result = parseExtensionMetadataJsonValue(item, depth + 1);
      if (result === invalidExtensionMetadataValue) {
        return result;
      }
      parsed.push(result);
    }
    return parsed;
  }
  if (!isRecord(value)) {
    return invalidExtensionMetadataValue;
  }
  const entries = Object.entries(value);
  if (entries.length > maximumExtensionMetadataObjectProperties) {
    return invalidExtensionMetadataValue;
  }
  const parsed: Array<[string, ExtensionMetadataJsonValue]> = [];
  for (const [key, item] of entries) {
    if (!extensionMetadataPropertyPattern.test(key)) {
      return invalidExtensionMetadataValue;
    }
    const result = parseExtensionMetadataJsonValue(item, depth + 1);
    if (result === invalidExtensionMetadataValue) {
      return result;
    }
    parsed.push([key, result]);
  }
  return Object.fromEntries(parsed);
}

function parseExtensionMetadataPayload(
  value: unknown,
): ExtensionMetadataPayload | null {
  if (!isRecord(value) || Array.isArray(value)) {
    return null;
  }
  const parsed = parseExtensionMetadataJsonValue(value, 1);
  return parsed === invalidExtensionMetadataValue || Array.isArray(parsed)
    ? null
    : (parsed as ExtensionMetadataPayload);
}

function parseWorkspaceExtensionMetadata(
  value: unknown,
  nodeIds: ReadonlySet<string>,
): Record<string, WorkspaceExtensionMetadata> | null {
  if (!isRecord(value) || Array.isArray(value)) {
    return null;
  }
  const extensionEntries = Object.entries(value);
  if (extensionEntries.length > maximumExtensionCount) {
    return null;
  }
  const parsedExtensions: Array<[string, WorkspaceExtensionMetadata]> = [];
  for (const [extensionId, candidate] of extensionEntries) {
    if (
      extensionId.length > 128 ||
      !extensionIdPattern.test(extensionId) ||
      !isRecord(candidate) ||
      Array.isArray(candidate) ||
      Object.keys(candidate).length !== 3 ||
      !Object.prototype.hasOwnProperty.call(candidate, "schemaVersion") ||
      !Object.prototype.hasOwnProperty.call(candidate, "workspace") ||
      !Object.prototype.hasOwnProperty.call(candidate, "byNodeId") ||
      !Number.isInteger(candidate.schemaVersion) ||
      (candidate.schemaVersion as number) <= 0 ||
      (candidate.schemaVersion as number) > 0xffff_ffff
    ) {
      return null;
    }
    const workspace = parseExtensionMetadataPayload(candidate.workspace);
    if (
      workspace === null ||
      utf8JsonSize(workspace) > maximumWorkspaceExtensionMetadataBytes ||
      !isRecord(candidate.byNodeId) ||
      Array.isArray(candidate.byNodeId)
    ) {
      return null;
    }
    const byNodeIdEntries: Array<[string, ExtensionMetadataPayload]> = [];
    const seenNodeIds = new Set<string>();
    for (const [rawNodeId, rawPayload] of Object.entries(candidate.byNodeId)) {
      const nodeId = canonicalNodeId(rawNodeId);
      const payload = parseExtensionMetadataPayload(rawPayload);
      if (
        nodeId === null ||
        !nodeIds.has(nodeId) ||
        seenNodeIds.has(nodeId) ||
        payload === null ||
        utf8JsonSize(payload) > maximumNodeExtensionMetadataBytes
      ) {
        return null;
      }
      seenNodeIds.add(nodeId);
      byNodeIdEntries.push([nodeId, payload]);
    }
    const extension: WorkspaceExtensionMetadata = {
      schemaVersion: candidate.schemaVersion as number,
      workspace,
      byNodeId: Object.fromEntries(byNodeIdEntries),
    };
    if (utf8JsonSize(extension) > maximumSingleExtensionMetadataBytes) {
      return null;
    }
    parsedExtensions.push([extensionId, extension]);
  }
  const parsed = Object.fromEntries(parsedExtensions);
  return utf8JsonSize(parsed) <= maximumTotalExtensionMetadataBytes
    ? parsed
    : null;
}

export function emptyWorkspace(): WorkspaceSnapshot {
  return {
    nodes: [],
    references: [],
    view: {
      activeCanvasId: defaultCanvasId,
      canvases: [
        {
          id: defaultCanvasId,
          name: defaultCanvasName,
          layout: [],
          viewport: null,
        },
      ],
      contentProcessorByNodeId: {},
      extensionMetadata: {},
      timeline: null,
    },
  };
}

export function activeWorkspaceCanvas(
  workspace: WorkspaceSnapshot,
): WorkspaceCanvas {
  const canvas = workspace.view.canvases.find(
    (item) => item.id === workspace.view.activeCanvasId,
  );
  if (canvas !== undefined) {
    return canvas;
  }
  const fallback = workspace.view.canvases[0];
  if (fallback === undefined) {
    throw new Error("Workspace must contain at least one canvas.");
  }
  return fallback;
}

export function updateWorkspaceCanvas(
  view: WorkspaceViewMetadata,
  canvasId: string,
  updater: (canvas: WorkspaceCanvas) => WorkspaceCanvas,
): WorkspaceViewMetadata {
  let changed = false;
  const canvases = view.canvases.map((canvas) => {
    if (canvas.id !== canvasId) {
      return canvas;
    }
    const next = updater(canvas);
    changed = changed || next !== canvas;
    return next;
  });
  return changed ? { ...view, canvases } : view;
}

export function normalizeNodeName(name: string): string {
  return name.trim().toLowerCase();
}

export function persistedNodeNameFromDraft(name: string): string | null {
  return name.trim().length === 0 ? null : name;
}

export function isUnnamedNode(node: InformationNode): boolean {
  return node.name === null || node.name.trim().length === 0;
}

export function isNodeNameAvailable(
  nodes: InformationNode[],
  nodeId: string,
  candidateName: string,
): boolean {
  const normalizedCandidate = normalizeNodeName(candidateName);
  return (
    normalizedCandidate.length === 0 ||
    !nodes.some(
      (node) =>
        node.id !== nodeId &&
        normalizeNodeName(node.name ?? "") === normalizedCandidate,
    )
  );
}

export function moveNodeLayoutToFront(
  layout: NodeLayout[],
  nodeId: string,
): NodeLayout[] {
  const currentIndex = layout.findIndex((item) => item.nodeId === nodeId);
  if (currentIndex < 0 || currentIndex === layout.length - 1) {
    return layout;
  }

  const item = layout[currentIndex];
  return [
    ...layout.slice(0, currentIndex),
    ...layout.slice(currentIndex + 1),
    item,
  ];
}

export function updateNodeLayoutPositions(
  layout: NodeLayout[],
  positions: Array<{ nodeId: string; x: number; y: number }>,
): NodeLayout[] {
  if (positions.length === 0) {
    return layout;
  }

  const positionByNodeId = new Map(positions.map((position) => [position.nodeId, position]));
  const existingNodeIds = new Set(layout.map((item) => item.nodeId));
  let changed = false;
  const updated = layout.map((item) => {
    const position = positionByNodeId.get(item.nodeId);
    if (position === undefined || (position.x === item.x && position.y === item.y)) {
      return item;
    }
    changed = true;
    return { ...item, x: position.x, y: position.y };
  });
  const missing = positions.filter((position) => !existingNodeIds.has(position.nodeId));
  if (missing.length > 0) {
    changed = true;
    updated.push(...missing.map((position) => ({ ...position })));
  }

  return changed ? updated : layout;
}

export function updateNodeLayoutDimensions(
  layout: NodeLayout[],
  nodeId: string,
  dimensions: { height: number; width: number; x: number; y: number } | null,
): NodeLayout[] {
  const index = layout.findIndex((item) => item.nodeId === nodeId);
  if (index < 0) {
    return layout;
  }
  const current = layout[index];
  const next =
    dimensions === null
      ? { nodeId: current.nodeId, x: current.x, y: current.y }
      : {
          nodeId: current.nodeId,
          x: dimensions.x,
          y: dimensions.y,
          width: Math.min(
            maximumManualNodeDimension,
            Math.max(minimumManualNodeWidth, dimensions.width),
          ),
          height: Math.min(
            maximumManualNodeDimension,
            Math.max(minimumManualNodeHeight, dimensions.height),
          ),
        };
  if (
    current.x === next.x &&
    current.y === next.y &&
    current.width === next.width &&
    current.height === next.height
  ) {
    return layout;
  }
  const updated = [...layout];
  updated[index] = next;
  return updated;
}

export interface NodeLayoutSizeOverrideUpdate {
  height?: number | null;
  nodeId: string;
  width?: number | null;
}

export function updateNodeLayoutSizeOverrides(
  layout: NodeLayout[],
  updates: readonly NodeLayoutSizeOverrideUpdate[],
): NodeLayout[] {
  if (updates.length === 0) {
    return layout;
  }
  const updateByNodeId = new Map(updates.map((update) => [update.nodeId, update]));
  let changed = false;
  const next = layout.map((item) => {
    const update = updateByNodeId.get(item.nodeId);
    if (update === undefined) {
      return item;
    }
    const width =
      update.width === undefined
        ? item.width
        : update.width === null
          ? undefined
          : Math.min(
              maximumManualNodeDimension,
              Math.max(minimumManualNodeWidth, update.width),
            );
    const height =
      update.height === undefined
        ? item.height
        : update.height === null
          ? undefined
          : Math.min(
              maximumManualNodeDimension,
              Math.max(minimumManualNodeHeight, update.height),
            );
    if (width === item.width && height === item.height) {
      return item;
    }
    changed = true;
    return {
      nodeId: item.nodeId,
      x: item.x,
      y: item.y,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    };
  });
  return changed ? next : layout;
}

function parseCanvasViewport(value: unknown): CanvasViewport | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    !isRecord(value) ||
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y) ||
    !isFiniteNumber(value.zoom) ||
    value.zoom <= 0
  ) {
    return undefined;
  }
  return { x: value.x, y: value.y, zoom: value.zoom };
}

function parseNodeLayout(
  value: unknown,
  nodeIds: ReadonlySet<string>,
  requireEveryNode: boolean,
): NodeLayout[] | null {
  if (!Array.isArray(value) || (requireEveryNode && value.length !== nodeIds.size)) {
    return null;
  }
  const layout: NodeLayout[] = [];
  const layoutNodeIds = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) {
      return null;
    }
    const nodeId = canonicalNodeId(candidate.nodeId);
    if (
      nodeId === null ||
      !nodeIds.has(nodeId) ||
      layoutNodeIds.has(nodeId) ||
      !isFiniteNumber(candidate.x) ||
      !isFiniteNumber(candidate.y)
    ) {
      return null;
    }
    let width: number | undefined;
    let height: number | undefined;
    if (candidate.width !== undefined) {
      if (
        !isFiniteNumber(candidate.width) ||
        candidate.width < minimumManualNodeWidth ||
        candidate.width > maximumManualNodeDimension
      ) {
        return null;
      }
      width = candidate.width;
    }
    if (candidate.height !== undefined) {
      if (
        !isFiniteNumber(candidate.height) ||
        candidate.height < minimumManualNodeHeight ||
        candidate.height > maximumManualNodeDimension
      ) {
        return null;
      }
      height = candidate.height;
    }
    layoutNodeIds.add(nodeId);
    layout.push({
      nodeId,
      x: candidate.x,
      y: candidate.y,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    });
  }
  return layout;
}

function parseCanvasBookmarks(
  value: unknown,
  canvasIds: ReadonlySet<string>,
): CanvasBookmark[] | null {
  if (!Array.isArray(value) || value.length > maximumCanvasBookmarkCount) {
    return null;
  }
  const bookmarks: CanvasBookmark[] = [];
  const bookmarkIds = new Set<string>();
  const normalizedNames = new Set<string>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== 6 ||
      typeof candidate.name !== "string"
    ) {
      return null;
    }
    const id = canonicalNodeId(candidate.id);
    const canvasId = canonicalNodeId(candidate.canvasId);
    const name = candidate.name.trim();
    const normalizedName = normalizeNodeName(name);
    if (
      id === null ||
      canvasId === null ||
      !canvasIds.has(canvasId) ||
      bookmarkIds.has(id) ||
      name.length === 0 ||
      [...name].length > maximumCanvasBookmarkNameCharacters ||
      normalizedNames.has(normalizedName) ||
      !isFiniteNumber(candidate.x) ||
      !isFiniteNumber(candidate.y) ||
      !isFiniteNumber(candidate.zoom) ||
      candidate.zoom <= 0
    ) {
      return null;
    }
    bookmarkIds.add(id);
    normalizedNames.add(normalizedName);
    bookmarks.push({
      id,
      name,
      canvasId,
      x: candidate.x,
      y: candidate.y,
      zoom: candidate.zoom,
    });
  }
  return bookmarks;
}

function isValidTimelineDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ];
  return day <= daysInMonth[month - 1];
}

function parseWorkspaceTimeline(
  value: unknown,
  canvasIds: ReadonlySet<string>,
  nodeIds: ReadonlySet<string>,
): WorkspaceTimeline | null | undefined {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    !Array.isArray(value.days) ||
    !Array.isArray(value.captures) ||
    value.days.length + value.captures.length > nodeIds.size
  ) {
    return undefined;
  }
  const canvasId = canonicalNodeId(value.canvasId);
  if (canvasId === null || !canvasIds.has(canvasId)) {
    return undefined;
  }
  const dates = new Set<string>();
  const timelineNodeIds = new Set<string>();
  const days: WorkspaceTimelineDay[] = [];
  for (const candidate of value.days) {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== 2 ||
      !isValidTimelineDate(candidate.date) ||
      dates.has(candidate.date)
    ) {
      return undefined;
    }
    const nodeId = canonicalNodeId(candidate.nodeId);
    if (nodeId === null || !nodeIds.has(nodeId) || timelineNodeIds.has(nodeId)) {
      return undefined;
    }
    dates.add(candidate.date);
    timelineNodeIds.add(nodeId);
    days.push({ date: candidate.date, nodeId });
  }
  const captures: WorkspaceTimelineCapture[] = [];
  for (const candidate of value.captures) {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== 4 ||
      typeof candidate.day !== "string" ||
      !dates.has(candidate.day) ||
      !isFiniteNumber(candidate.capturedAtMs) ||
      !Number.isInteger(candidate.capturedAtMs) ||
      candidate.capturedAtMs < 0 ||
      candidate.capturedAtMs > 253_402_300_799_999 ||
      !isFiniteNumber(candidate.utcOffsetMinutes) ||
      !Number.isInteger(candidate.utcOffsetMinutes) ||
      candidate.utcOffsetMinutes < -840 ||
      candidate.utcOffsetMinutes > 840
    ) {
      return undefined;
    }
    const nodeId = canonicalNodeId(candidate.nodeId);
    if (
      nodeId === null ||
      !nodeIds.has(nodeId) ||
      timelineNodeIds.has(nodeId) ||
      new Date(candidate.capturedAtMs + candidate.utcOffsetMinutes * 60_000)
        .toISOString()
        .slice(0, 10) !== candidate.day
    ) {
      return undefined;
    }
    timelineNodeIds.add(nodeId);
    captures.push({
      nodeId,
      capturedAtMs: candidate.capturedAtMs,
      utcOffsetMinutes: candidate.utcOffsetMinutes,
      day: candidate.day,
    });
  }
  return { canvasId, days, captures };
}

function parseWorkspaceSnapshotValue(
  value: unknown,
  version: WorkspaceSnapshotVersion,
  allowOptionalViewFields = false,
): WorkspaceSnapshot | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.references) ||
    (value.version !== undefined && value.version !== version)
  ) {
    return null;
  }
  const allowedKeys = new Set(
    version >= 4
      ? ["nodes", "references", "view", "version"]
      : version === 1
        ? ["nodes", "layout", "references", "viewport", "version"]
        : ["nodes", "layout", "references", "viewport", "view", "version"],
  );
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return null;
  }

  const nodes: InformationNode[] = [];
  const nodeIds = new Set<string>();
  const normalizedNames = new Set<string>();
  for (const candidate of value.nodes) {
    if (
      !isRecord(candidate) ||
      (candidate.name !== null && typeof candidate.name !== "string") ||
      (candidate.content !== null && typeof candidate.content !== "string")
    ) {
      return null;
    }

    const id = canonicalNodeId(candidate.id);
    if (id === null || nodeIds.has(id)) {
      return null;
    }

    const name = candidate.name === null ? null : candidate.name.trim();
    if (name !== null) {
      const normalizedName = normalizeNodeName(name);
      if (normalizedName.length === 0 || normalizedNames.has(normalizedName)) {
        return null;
      }
      normalizedNames.add(normalizedName);
    }

    nodeIds.add(id);
    nodes.push({ id, name, content: candidate.content });
  }

  const references: NodeReference[] = [];
  const referenceKeys = new Set<string>();
  for (const candidate of value.references) {
    if (!isRecord(candidate)) {
      return null;
    }
    const sourceNodeId = canonicalNodeId(candidate.sourceNodeId);
    const targetNodeId = canonicalNodeId(candidate.targetNodeId);
    if (
      sourceNodeId === null ||
      targetNodeId === null ||
      !nodeIds.has(sourceNodeId) ||
      !nodeIds.has(targetNodeId)
    ) {
      return null;
    }
    const key = `${sourceNodeId}\u0000${targetNodeId}`;
    if (referenceKeys.has(key)) {
      return null;
    }
    referenceKeys.add(key);
    references.push({ sourceNodeId, targetNodeId });
  }

  let contentProcessorByNodeId: Record<string, string> = {};
  let extensionMetadata: Record<string, WorkspaceExtensionMetadata> = {};
  let canvases: WorkspaceCanvas[];
  let activeCanvasId: string;
  let bookmarks: CanvasBookmark[] | undefined;
  let timeline: WorkspaceTimeline | null = null;
  if (version >= 4) {
    const allowedViewKeys = new Set([
      "activeCanvasId",
      "canvases",
      "contentProcessorByNodeId",
      "extensionMetadata",
      ...(version >= 5 ? ["bookmarks"] : []),
      ...(version >= 6 ? ["timeline"] : []),
    ]);
    if (
      !isRecord(value.view) ||
      Array.isArray(value.view) ||
      Object.keys(value.view).some((key) => !allowedViewKeys.has(key)) ||
      (!allowOptionalViewFields &&
        Object.keys(value.view).length !== allowedViewKeys.size) ||
      !Array.isArray(value.view.canvases) ||
      value.view.canvases.length === 0 ||
      value.view.canvases.length > maximumWorkspaceCanvasCount
    ) {
      return null;
    }
    const parsedCanvases: WorkspaceCanvas[] = [];
    const canvasIds = new Set<string>();
    const normalizedCanvasNames = new Set<string>();
    let totalPlacements = 0;
    for (const candidate of value.view.canvases) {
      if (
        !isRecord(candidate) ||
        Object.keys(candidate).length !== 4 ||
        typeof candidate.name !== "string"
      ) {
        return null;
      }
      const id = canonicalNodeId(candidate.id);
      const name = candidate.name.trim();
      const normalizedName = name.toLowerCase();
      const layout = parseNodeLayout(candidate.layout, nodeIds, false);
      const viewport = parseCanvasViewport(candidate.viewport);
      if (
        id === null ||
        canvasIds.has(id) ||
        name.length === 0 ||
        [...name].length > maximumCanvasNameCharacters ||
        normalizedCanvasNames.has(normalizedName) ||
        layout === null ||
        viewport === undefined
      ) {
        return null;
      }
      totalPlacements += layout.length;
      if (totalPlacements > maximumTotalCanvasPlacements) {
        return null;
      }
      canvasIds.add(id);
      normalizedCanvasNames.add(normalizedName);
      parsedCanvases.push({ id, name, layout, viewport });
    }
    const parsedActiveCanvasId = canonicalNodeId(value.view.activeCanvasId);
    if (parsedActiveCanvasId === null || !canvasIds.has(parsedActiveCanvasId)) {
      return null;
    }
    canvases = parsedCanvases;
    activeCanvasId = parsedActiveCanvasId;
    if (
      version >= 5 &&
      Object.prototype.hasOwnProperty.call(value.view, "bookmarks")
    ) {
      bookmarks = parseCanvasBookmarks(value.view.bookmarks, canvasIds) ?? undefined;
      if (bookmarks === undefined) {
        return null;
      }
    }
    if (version === 6) {
      const parsedTimeline = parseWorkspaceTimeline(
        value.view.timeline === undefined && allowOptionalViewFields
          ? null
          : value.view.timeline,
        canvasIds,
        nodeIds,
      );
      if (parsedTimeline === undefined) {
        return null;
      }
      timeline = parsedTimeline;
    }
  } else {
    const layout = parseNodeLayout(value.layout, nodeIds, true);
    const viewport = parseCanvasViewport(value.viewport);
    if (layout === null || viewport === undefined) {
      return null;
    }
    canvases = [
      {
        id: defaultCanvasId,
        name: defaultCanvasName,
        layout,
        viewport,
      },
    ];
    activeCanvasId = defaultCanvasId;
  }

  if (version !== 1 && value.view !== undefined) {
    if (
      !isRecord(value.view) ||
      Array.isArray(value.view) ||
      !isRecord(value.view.contentProcessorByNodeId) ||
      Array.isArray(value.view.contentProcessorByNodeId) ||
      (version === 2 && Object.keys(value.view).length !== 1) ||
      (version === 3 && Object.keys(value.view).length !== 2) ||
      (version === 2 &&
        Object.prototype.hasOwnProperty.call(value.view, "extensionMetadata"))
    ) {
      return null;
    }
    contentProcessorByNodeId = {};
    for (const [rawNodeId, processorId] of Object.entries(
      value.view.contentProcessorByNodeId,
    )) {
      const nodeId = canonicalNodeId(rawNodeId);
      if (
        nodeId === null ||
        !nodeIds.has(nodeId) ||
        Object.prototype.hasOwnProperty.call(contentProcessorByNodeId, nodeId) ||
        typeof processorId !== "string" ||
        processorId === "text" ||
        !contentProcessorIdPattern.test(processorId)
      ) {
        return null;
      }
      contentProcessorByNodeId[nodeId] = processorId;
    }
    if (version >= 3) {
      const parsedExtensionMetadata = parseWorkspaceExtensionMetadata(
        value.view.extensionMetadata,
        nodeIds,
      );
      if (parsedExtensionMetadata === null) {
        return null;
      }
      extensionMetadata = parsedExtensionMetadata;
    }
  } else if (version !== 1) {
    return null;
  }

  return {
    nodes,
    references,
    view: {
      activeCanvasId,
      canvases,
      contentProcessorByNodeId,
      extensionMetadata,
      ...(bookmarks === undefined || bookmarks.length === 0 ? {} : { bookmarks }),
      timeline,
    },
  };
}

export function parseWorkspaceSnapshot(value: unknown): WorkspaceSnapshot | null {
  return parseWorkspaceSnapshotValue(
    value,
    6,
    isRecord(value) && value.version === undefined,
  );
}

export function parseWorkspaceSnapshotV6(value: unknown): WorkspaceSnapshot | null {
  return parseWorkspaceSnapshotValue(value, 6);
}

export function migrateWorkspaceSnapshotV5(
  value: unknown,
): WorkspaceSnapshot | null {
  return parseWorkspaceSnapshotValue(value, 5);
}

export function migrateWorkspaceSnapshotV4(
  value: unknown,
): WorkspaceSnapshot | null {
  const parsed = parseWorkspaceSnapshotValue(value, 4);
  if (parsed === null) {
    return null;
  }
  return {
    ...parsed,
    view: { ...parsed.view, bookmarks: [] },
  };
}

export function migrateWorkspaceSnapshotV1(
  value: unknown,
): WorkspaceSnapshot | null {
  return parseWorkspaceSnapshotValue(value, 1);
}

export function migrateWorkspaceSnapshotV2(
  value: unknown,
): WorkspaceSnapshot | null {
  return parseWorkspaceSnapshotValue(value, 2);
}

export function migrateWorkspaceSnapshotV3(
  value: unknown,
): WorkspaceSnapshot | null {
  return parseWorkspaceSnapshotValue(value, 3);
}

export function removeNodesFromWorkspaceView(
  view: WorkspaceViewMetadata,
  deletedNodeIds: ReadonlySet<string>,
): WorkspaceViewMetadata {
  const entries = Object.entries(view.contentProcessorByNodeId).filter(
    ([nodeId]) => !deletedNodeIds.has(nodeId),
  );
  let extensionMetadataChanged = false;
  let canvasesChanged = false;
  let timelineChanged = false;
  let timeline = view.timeline ?? null;
  if (timeline !== null) {
    const days = timeline.days.filter((day) => !deletedNodeIds.has(day.nodeId));
    const retainedDates = new Set(days.map((day) => day.date));
    const captures = timeline.captures.filter(
      (capture) =>
        !deletedNodeIds.has(capture.nodeId) && retainedDates.has(capture.day),
    );
    timelineChanged =
      days.length !== timeline.days.length ||
      captures.length !== timeline.captures.length;
    if (timelineChanged) {
      timeline = { ...timeline, days, captures };
    }
  }
  const canvases = view.canvases.map((canvas) => {
    const layout = canvas.layout.filter(
      (item) => !deletedNodeIds.has(item.nodeId),
    );
    if (layout.length !== canvas.layout.length) {
      canvasesChanged = true;
      return { ...canvas, layout };
    }
    return canvas;
  });
  const extensionMetadata = Object.fromEntries(
    Object.entries(view.extensionMetadata).map(([extensionId, metadata]) => {
      const byNodeId = Object.fromEntries(
        Object.entries(metadata.byNodeId).filter(
          ([nodeId]) => !deletedNodeIds.has(nodeId),
        ),
      );
      if (Object.keys(byNodeId).length !== Object.keys(metadata.byNodeId).length) {
        extensionMetadataChanged = true;
        return [extensionId, { ...metadata, byNodeId }];
      }
      return [extensionId, metadata];
    }),
  );
  if (
    entries.length === Object.keys(view.contentProcessorByNodeId).length &&
    !canvasesChanged &&
    !extensionMetadataChanged &&
    !timelineChanged
  ) {
    return view;
  }
  return {
    ...view,
    canvases,
    contentProcessorByNodeId: Object.fromEntries(entries),
    extensionMetadata,
    timeline,
  };
}

function extensionMetadataPayloadIsEmpty(
  payload: ExtensionMetadataPayload,
): boolean {
  return Object.keys(payload).length === 0;
}

export function replaceWorkspaceExtensionMetadata(
  view: WorkspaceViewMetadata,
  nodes: readonly InformationNode[],
  extensionId: string,
  metadata: WorkspaceExtensionMetadata | null,
): WorkspaceViewMetadata | null {
  const nextExtensionMetadata = { ...view.extensionMetadata };
  if (metadata === null) {
    if (!(extensionId in nextExtensionMetadata)) {
      return view;
    }
    delete nextExtensionMetadata[extensionId];
  } else {
    nextExtensionMetadata[extensionId] = metadata;
  }
  const parsed = parseWorkspaceExtensionMetadata(
    nextExtensionMetadata,
    new Set(nodes.map((node) => node.id)),
  );
  return parsed === null
    ? null
    : {
        ...view,
        extensionMetadata: parsed,
      };
}

export function updateNodeExtensionMetadata(
  view: WorkspaceViewMetadata,
  nodes: readonly InformationNode[],
  extensionId: string,
  schemaVersion: number,
  nodeId: string,
  nodeMetadata: ExtensionMetadataPayload | null,
  workspaceMetadata: ExtensionMetadataPayload | null = null,
): WorkspaceViewMetadata | null {
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (!nodeIds.has(nodeId)) {
    return null;
  }
  const current = view.extensionMetadata[extensionId];
  if (current !== undefined && current.schemaVersion !== schemaVersion) {
    return null;
  }
  if (current === undefined && nodeMetadata === null && workspaceMetadata === null) {
    return view;
  }
  const nextWorkspace = workspaceMetadata ?? current?.workspace ?? {};
  const nextByNodeId = { ...(current?.byNodeId ?? {}) };
  if (nodeMetadata !== null) {
    if (extensionMetadataPayloadIsEmpty(nodeMetadata)) {
      delete nextByNodeId[nodeId];
    } else {
      nextByNodeId[nodeId] = nodeMetadata;
    }
  }
  const nextExtensionMetadata = { ...view.extensionMetadata };
  if (
    extensionMetadataPayloadIsEmpty(nextWorkspace) &&
    Object.keys(nextByNodeId).length === 0
  ) {
    delete nextExtensionMetadata[extensionId];
  } else {
    nextExtensionMetadata[extensionId] = {
      schemaVersion,
      workspace: nextWorkspace,
      byNodeId: nextByNodeId,
    };
  }
  const parsed = parseWorkspaceExtensionMetadata(nextExtensionMetadata, nodeIds);
  if (parsed === null) {
    return null;
  }
  return {
    ...view,
    extensionMetadata: parsed,
  };
}

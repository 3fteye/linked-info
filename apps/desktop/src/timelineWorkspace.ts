import {
  maximumWorkspaceCanvasCount,
  normalizeNodeName,
  parseWorkspaceSnapshot,
  type NodeLayout,
  type NodeReference,
  type WorkspaceSnapshot,
} from "./workspaceData";

export interface TimelineNoteInput {
  /** Reuse for retries of the same immutable submission. */
  nodeId: string;
  name: string;
  content: string;
  capturedAtMs: number;
  /** Minutes east of UTC, captured with the record, not recomputed on load. */
  utcOffsetMinutes: number;
}

export interface TimelineCaptureLabels {
  canvasName: string;
  dateNodeName: (date: string) => string;
}

export type TimelineCaptureFailure =
  | "invalid-input"
  | "empty-note"
  | "duplicate-name"
  | "identity-conflict"
  | "canvas-limit"
  | "invalid-result";

export class TimelineCaptureError extends Error {
  constructor(readonly reason: TimelineCaptureFailure) {
    super(`timeline_capture_${reason}`);
  }
}

export interface TimelineCaptureResult {
  workspace: WorkspaceSnapshot;
  nodeId: string;
  dayNodeId: string;
  canvasId: string;
  duplicate: boolean;
}

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noteWidth = 320;
const noteHeight = 220;
const dateWidth = 240;
const dateHeight = 100;
const gap = 60;
const maximumCaptureNameCharacters = 512;

/** Capture-only naming; ordinary node editing keeps its existing uniqueness rule. */
export function resolveTimelineNoteName(
  nodeId: string,
  draftName: string,
  otherNames: Iterable<string | null>,
): string | null {
  if (!canonicalUuid.test(nodeId) || typeof draftName !== "string" ||
    Array.from(draftName).length > maximumCaptureNameCharacters) {
    throw new TimelineCaptureError("invalid-input");
  }
  const base = draftName.trim();
  if (base.length === 0) return null;
  const occupied = new Set(Array.from(otherNames, (name) => normalizeNodeName(name ?? "")));
  if (!occupied.has(normalizeNodeName(base))) return base;
  const characters = Array.from(base);
  const shortId = nodeId.slice(0, 8);
  // Every suffix is distinct, so at most occupied.size candidates can be taken.
  // This bound and scalar-value truncation are shared with the Rust verifier.
  for (let attempt = 1; attempt <= occupied.size + 1; attempt += 1) {
    const suffix = attempt === 1 ? ` (${shortId})` : ` (${shortId}-${attempt})`;
    const prefix = characters.slice(0, maximumCaptureNameCharacters - suffix.length).join("");
    const candidate = `${prefix}${suffix}`;
    if (!occupied.has(normalizeNodeName(candidate))) return candidate;
  }
  throw new TimelineCaptureError("invalid-result");
}

export function timelineDayAt(capturedAtMs: number, utcOffsetMinutes: number): string {
  if (
    !Number.isSafeInteger(capturedAtMs) ||
    capturedAtMs < 0 ||
    capturedAtMs > 253402300799999 ||
    !Number.isInteger(utcOffsetMinutes) ||
    utcOffsetMinutes < -840 ||
    utcOffsetMinutes > 840
  ) {
    throw new TimelineCaptureError("invalid-input");
  }
  const date = new Date(capturedAtMs + utcOffsetMinutes * 60_000);
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
    throw new TimelineCaptureError("invalid-input");
  }
  return date.toISOString().slice(0, 10);
}

function uniqueGeneratedName(base: string, names: ReadonlySet<string>): string {
  const name = base.trim();
  if (name.length === 0) {
    throw new TimelineCaptureError("invalid-input");
  }
  let candidate = name;
  let index = 2;
  while (names.has(normalizeNodeName(candidate))) {
    candidate = `${name} (${index})`;
    index += 1;
  }
  return candidate;
}

/**
 * Only place the new card. Existing user placements are never reflowed.
 * Sort obstructing intervals once instead of repeatedly scanning the full graph.
 */
function appendInRow(
  layout: readonly NodeLayout[],
  nodeId: string,
  initialX: number,
  y: number,
): NodeLayout {
  const intervals = layout
    .filter((item) =>
      item.y < y + noteHeight + gap &&
      item.y + (item.height ?? noteHeight) + gap > y,
    )
    .map((item) => ({ left: item.x, right: item.x + (item.width ?? noteWidth) }))
    .sort((left, right) => left.left - right.left);
  let x = initialX;
  for (const interval of intervals) {
    if (x < interval.right + gap && x + noteWidth + gap > interval.left) {
      x = interval.right + gap;
    }
  }
  return { nodeId, x, y, width: noteWidth, height: noteHeight };
}

/** Prepare a complete immutable transaction; the owner must persist before ACK. */
export function captureTimelineNote(
  workspace: WorkspaceSnapshot,
  input: TimelineNoteInput,
  labels: TimelineCaptureLabels,
  newId: () => string,
): TimelineCaptureResult {
  if (
    !canonicalUuid.test(input.nodeId) ||
    typeof input.name !== "string" || typeof input.content !== "string"
  ) {
    throw new TimelineCaptureError("invalid-input");
  }
  const day = timelineDayAt(input.capturedAtMs, input.utcOffsetMinutes);
  const name = resolveTimelineNoteName(
    input.nodeId,
    input.name,
    workspace.nodes.filter((node) => node.id !== input.nodeId).map((node) => node.name),
  );
  const content = input.content.length === 0 ? null : input.content;
  if (name === null && input.content.trim().length === 0) {
    throw new TimelineCaptureError("empty-note");
  }
  const currentTimeline = workspace.view.timeline ?? null;
  const existing = workspace.nodes.find((node) => node.id === input.nodeId);
  if (existing !== undefined) {
    const capture = currentTimeline?.captures.find((item) => item.nodeId === input.nodeId);
    const dateNode = currentTimeline?.days.find((item) => item.date === day);
    if (
      currentTimeline !== null && dateNode !== undefined &&
      existing.name === name && existing.content === content &&
      capture?.day === day && capture.capturedAtMs === input.capturedAtMs &&
      capture.utcOffsetMinutes === input.utcOffsetMinutes
    ) {
      return {
        workspace, nodeId: input.nodeId, dayNodeId: dateNode.nodeId,
        canvasId: currentTimeline.canvasId, duplicate: true,
      };
    }
    throw new TimelineCaptureError("identity-conflict");
  }
  if (currentTimeline === null && workspace.view.canvases.length >= maximumWorkspaceCanvasCount) {
    throw new TimelineCaptureError("canvas-limit");
  }

  const usedIds = new Set([
    ...workspace.nodes.map((node) => node.id),
    ...workspace.view.canvases.map((canvas) => canvas.id), input.nodeId,
  ]);
  function allocateId(): string {
    const id = newId();
    if (!canonicalUuid.test(id) || usedIds.has(id)) {
      throw new TimelineCaptureError("identity-conflict");
    }
    usedIds.add(id);
    return id;
  }
  const canvas = currentTimeline === null
    ? {
        id: allocateId(),
        name: uniqueGeneratedName(labels.canvasName, new Set(
          workspace.view.canvases.map((item) => normalizeNodeName(item.name)),
        )),
        layout: [] as NodeLayout[], viewport: null,
      }
    : workspace.view.canvases.find((item) => item.id === currentTimeline.canvasId);
  if (canvas === undefined) {
    throw new TimelineCaptureError("invalid-result");
  }
  let days = currentTimeline?.days ?? [];
  const previousDay = days.find((item) => item.date === day);
  const dayNodeId = previousDay?.nodeId ?? allocateId();
  const nodes = [...workspace.nodes];
  let references = workspace.references;
  let layout = canvas.layout;
  const noteNode = { id: input.nodeId, name, content };
  nodes.push(noteNode);

  function ensureReference(sourceNodeId: string, targetNodeId: string): void {
    if (!references.some((ref) => ref.sourceNodeId === sourceNodeId && ref.targetNodeId === targetNodeId)) {
      references = [...references, { sourceNodeId, targetNodeId }];
    }
  }
  if (previousDay === undefined) {
    const dateName = uniqueGeneratedName(labels.dateNodeName(day), new Set(
      nodes.map((node) => normalizeNodeName(node.name ?? "")),
    ));
    nodes.push({ id: dayNodeId, name: dateName, content: null });
    days = [...days, { date: day, nodeId: dayNodeId }].sort((left, right) =>
      left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
    );
    const index = days.findIndex((item) => item.date === day);
    const before = days[index - 1];
    const after = days[index + 1];
    const linkedNeighbors = before !== undefined && after !== undefined &&
      references.some((ref) => ref.sourceNodeId === before.nodeId && ref.targetNodeId === after.nodeId);
    if (linkedNeighbors) {
      references = references.filter((ref: NodeReference) =>
        ref.sourceNodeId !== before.nodeId || ref.targetNodeId !== after.nodeId,
      );
    }
    // A gap is user data too: inserting an older day must not reconnect it.
    if (before === undefined || after === undefined || linkedNeighbors) {
      if (before !== undefined) ensureReference(before.nodeId, dayNodeId);
      if (after !== undefined) ensureReference(dayNodeId, after.nodeId);
    }
  }
  let datePlacement = layout.find((item) => item.nodeId === dayNodeId);
  if (datePlacement === undefined && previousDay === undefined) {
    let bottom = -gap;
    for (const item of layout) {
      bottom = Math.max(bottom, item.y + (item.height ?? noteHeight));
    }
    datePlacement = { nodeId: dayNodeId, x: 0, y: bottom + gap, width: dateWidth, height: dateHeight };
    layout = [...layout, datePlacement];
  }
  // A manually removed date placement is not silently restored.
  const y = datePlacement?.y ?? layout.reduce((bottom, item) =>
    Math.max(bottom, item.y + (item.height ?? noteHeight) + gap), 0,
  );
  layout = [...layout, appendInRow(layout, input.nodeId,
    (datePlacement?.x ?? 0) + (datePlacement?.width ?? dateWidth) + gap, y)];
  ensureReference(input.nodeId, dayNodeId);

  const next: WorkspaceSnapshot = {
    ...workspace, nodes, references,
    view: {
      ...workspace.view,
      // Recording from the capsule must not steal the main canvas or viewport.
      canvases: currentTimeline === null
        ? [...workspace.view.canvases, { ...canvas, layout }]
        : workspace.view.canvases.map((item) => item.id === canvas.id ? { ...item, layout } : item),
      timeline: {
        canvasId: canvas.id, days,
        captures: [...(currentTimeline?.captures ?? []), {
          nodeId: input.nodeId, capturedAtMs: input.capturedAtMs,
          utcOffsetMinutes: input.utcOffsetMinutes, day,
        }],
      },
    },
  };
  if (parseWorkspaceSnapshot(next) === null) {
    throw new TimelineCaptureError("invalid-result");
  }
  return { workspace: next, nodeId: input.nodeId, dayNodeId, canvasId: canvas.id, duplicate: false };
}

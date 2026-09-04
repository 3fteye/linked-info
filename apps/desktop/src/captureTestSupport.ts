import { vi } from "vitest";
import type { CaptureBridge, CaptureRecord, CaptureSummary } from "./captureBridge";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

/** Synthetic only: shared across simulated restarts, with no filesystem access. */
export function syntheticCaptureBridge(seed: CaptureRecord[] = []) {
  const records = new Map(seed.map((record) => [record.id, { ...record }]));
  const closed = new Set<() => void>();
  let nextId = seed.length + 1;
  const bridge: CaptureBridge = {
    list: vi.fn(async () => [...records.values()].filter((record) => record.state !== "archived").map((record): CaptureSummary => ({
      id: record.id, revision: record.revision, state: record.state, name: record.name,
      capturedAtMs: record.capturedAtMs, utcOffsetMinutes: record.utcOffsetMinutes, failure: record.failure,
    }))),
    get: vi.fn(async (id) => {
      const record = records.get(id);
      return record === undefined ? null : { ...record };
    }),
    create: vi.fn(async () => {
      const record: CaptureRecord = {
        id: `11111111-1111-4111-8111-${String(nextId++).padStart(12, "0")}`,
        revision: 1, state: "draft", name: "", content: "", capturedAtMs: null,
        utcOffsetMinutes: null, failure: null,
      };
      records.set(record.id, record);
      return { ...record };
    }),
    save: vi.fn(async (id, expectedRevision, name, content) => {
      const previous = records.get(id);
      if (previous === undefined) throw "capture_not_found";
      if (previous.revision !== expectedRevision) throw "capture_conflict";
      if (!["draft", "pending", "failed"].includes(previous.state)) throw "capture_read_only";
      const record: CaptureRecord = { ...previous, revision: expectedRevision + 1, name, content, state: "draft", failure: null };
      records.set(id, record);
      return { ...record };
    }),
    submit: vi.fn(async (id, expectedRevision, capturedAtMs, utcOffsetMinutes) => {
      const previous = records.get(id);
      if (previous === undefined) throw "capture_not_found";
      if (previous.revision !== expectedRevision) throw "capture_conflict";
      if (previous.state !== "draft") throw "capture_read_only";
      const record: CaptureRecord = { ...previous, revision: expectedRevision + 1, state: "pending", capturedAtMs, utcOffsetMinutes };
      records.set(id, record);
      return { ...record };
    }),
    subscribeCloseRequested: vi.fn(async (listener) => {
      closed.add(listener);
      return () => { closed.delete(listener); };
    }),
    setExpanded: vi.fn(async () => undefined),
    drag: vi.fn(async () => undefined),
    exit: vi.fn(async () => undefined),
  };
  return { bridge, records, closed };
}

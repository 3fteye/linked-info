import { describe, expect, it, vi } from "vitest";
import { CaptureEditor } from "./captureEditor";
import type { CaptureRecord } from "./captureBridge";
import { deferred, syntheticCaptureBridge } from "./captureTestSupport";

const time = 1_788_422_400_000;

describe("independent capture editor", () => {
  it("persists drafts without a main owner and reloads them across simulated restarts", async () => {
    const { bridge } = syntheticCaptureBridge();
    const first = new CaptureEditor(bridge);
    await first.initialize();
    first.edit("content", "Synthetic durable local draft");
    await first.flush();
    expect(first.snapshot().local).toBe("saved");
    expect(bridge.submit).not.toHaveBeenCalled();
    const restarted = new CaptureEditor(bridge);
    await restarted.initialize();
    expect(restarted.snapshot().content).toBe("Synthetic durable local draft");
    expect(restarted.snapshot().record?.id).toBe(first.snapshot().record?.id);
    expect(bridge.create).toHaveBeenCalledOnce();
  });

  it("serializes revisions and never clears newer text when an older autosave completes", async () => {
    const { bridge } = syntheticCaptureBridge();
    const editor = new CaptureEditor(bridge);
    await editor.initialize();
    const save = bridge.save;
    const firstWrite = deferred<CaptureRecord>();
    vi.mocked(bridge.save).mockImplementationOnce(() => firstWrite.promise);
    editor.edit("content", "First snapshot");
    editor.edit("content", "Newer snapshot");
    const initial = editor.snapshot().record!;
    firstWrite.resolve({ ...initial, revision: initial.revision + 1, content: "First snapshot" });
    // The second write must use the revision confirmed by the first write.
    vi.mocked(bridge.save).mockImplementationOnce(async (id, revision, name, content) => ({
      ...initial, id, revision: revision + 1, name, content,
    }));
    await editor.flush();
    expect(save).toHaveBeenNthCalledWith(2, initial.id, initial.revision + 1, "", "Newer snapshot");
    expect(editor.snapshot().content).toBe("Newer snapshot");
    expect(editor.snapshot().local).toBe("saved");
  });

  it("submits one fixed revision and original time, then keeps pending text available", async () => {
    const { bridge } = syntheticCaptureBridge();
    const editor = new CaptureEditor(bridge);
    await editor.initialize();
    editor.edit("content", "Synthetic pending note");
    await editor.submit(time, 480);
    expect(bridge.submit).toHaveBeenCalledWith(editor.snapshot().record?.id, 2, time, 480);
    expect(editor.snapshot().record?.state).toBe("pending");
    expect(editor.snapshot().content).toBe("Synthetic pending note");
    await editor.submit(time + 1_000, 0);
    expect(bridge.submit).toHaveBeenCalledOnce();
  });

  it("withdraws pending with CAS before accepting edits, and preserves a winning claim", async () => {
    const { bridge, records } = syntheticCaptureBridge();
    const editor = new CaptureEditor(bridge);
    await editor.initialize();
    editor.edit("content", "Synthetic claimed note");
    await editor.submit(time, 480);
    const pending = editor.snapshot().record!;
    editor.edit("content", "Must not change pending text");
    expect(editor.snapshot().content).toBe(pending.content);
    records.set(pending.id, { ...pending, state: "claimed" });
    await editor.beginEdit();
    expect(editor.snapshot().record?.state).toBe("claimed");
    expect(editor.snapshot().notice).toBe("capture.changed");
    await editor.newDraft();
    editor.edit("content", "Another independent draft");
    await editor.flush();
    expect(editor.snapshot().record?.state).toBe("draft");
    expect(records.get(pending.id)?.content).toBe("Synthetic claimed note");
  });

  it("edits a withdrawn pending record under the same ID and a newer revision", async () => {
    const { bridge } = syntheticCaptureBridge();
    const editor = new CaptureEditor(bridge);
    await editor.initialize();
    editor.edit("content", "Original synthetic note");
    await editor.submit(time, 480);
    const pending = editor.snapshot().record!;
    await editor.beginEdit();
    expect(editor.snapshot().record?.state).toBe("draft");
    expect(bridge.save).toHaveBeenLastCalledWith(pending.id, pending.revision, pending.name, pending.content);
    editor.edit("content", "Corrected synthetic note");
    await editor.submit(time + 1_000, 480);
    expect(editor.snapshot().record?.id).toBe(pending.id);
    expect(editor.snapshot().record!.revision).toBeGreaterThan(pending.revision);
  });

  it("retains failed input and refuses to exit while local saving is unconfirmed", async () => {
    const { bridge } = syntheticCaptureBridge();
    const editor = new CaptureEditor(bridge);
    await editor.initialize();
    vi.mocked(bridge.save).mockRejectedValue("capture_io");
    editor.edit("content", "Retained synthetic text");
    await expect(editor.flush()).rejects.toBe("capture_io");
    await editor.exit();
    expect(bridge.exit).not.toHaveBeenCalled();
    expect(editor.snapshot().content).toBe("Retained synthetic text");
    expect(editor.snapshot().local).toBe("failed");
  });

  it("recovers a lost local save response from the same durable identity", async () => {
    const { bridge, records } = syntheticCaptureBridge();
    const editor = new CaptureEditor(bridge);
    await editor.initialize();
    vi.mocked(bridge.save).mockImplementationOnce(async (id, revision, name, content) => {
      records.set(id, { ...records.get(id)!, revision: revision + 1, name, content });
      throw "capture_io";
    });
    editor.edit("content", "Committed before response loss");
    await editor.flush();
    expect(editor.snapshot().local).toBe("saved");
    expect(bridge.create).toHaveBeenCalledOnce();
    expect(bridge.save).toHaveBeenCalledOnce();
  });

  it("queries the original submission after response loss without changing identity", async () => {
    const { bridge, records } = syntheticCaptureBridge();
    const editor = new CaptureEditor(bridge);
    await editor.initialize();
    editor.edit("content", "Synthetic uncertain submission");
    await editor.flush();
    vi.mocked(bridge.submit).mockImplementationOnce(async (id, revision, capturedAtMs, utcOffsetMinutes) => {
      records.set(id, { ...records.get(id)!, revision: revision + 1, state: "uncertain", capturedAtMs, utcOffsetMinutes });
      throw "capture_io";
    });
    await editor.submit(time, 480);
    expect(editor.snapshot().record?.state).toBe("uncertain");
    expect(editor.snapshot().content).toBe("Synthetic uncertain submission");
    await editor.submit(time + 1_000, 480);
    expect(bridge.submit).toHaveBeenCalledOnce();
  });

  it("only releases displayed text after a durable archived receipt is observed", async () => {
    const { bridge, records } = syntheticCaptureBridge();
    const editor = new CaptureEditor(bridge);
    await editor.initialize();
    editor.edit("content", "Synthetic archived note");
    await editor.submit(time, 480);
    const pending = editor.snapshot().record!;
    records.set(pending.id, { ...pending, state: "archived", name: "", content: "" });
    await editor.refresh();
    expect(editor.snapshot().record?.state).toBe("archived");
    expect(editor.snapshot().content).toBe("");
    expect(editor.snapshot().summaries).toEqual([]);
  });

  it("allows a new draft while one submission is in flight and ignores its late receipt", async () => {
    const { bridge, records } = syntheticCaptureBridge();
    const editor = new CaptureEditor(bridge);
    await editor.initialize();
    editor.edit("content", "Synthetic first in-flight note");
    await editor.flush();
    const original = editor.snapshot().record!;
    const response = deferred<CaptureRecord>();
    vi.mocked(bridge.submit).mockReturnValueOnce(response.promise);
    const submitting = editor.submit(time, 480);
    // Flush is already confirmed; allow the submission to enter its native wait.
    await Promise.resolve();
    expect(editor.snapshot().record?.state).toBe("uncertain");
    expect(editor.snapshot().busy).toBe(false);
    await editor.newDraft();
    editor.edit("content", "Synthetic newer editable draft");
    await editor.flush();
    const newerId = editor.snapshot().record!.id;
    const pending: CaptureRecord = { ...original, state: "pending", revision: original.revision + 1 };
    records.set(original.id, pending);
    response.resolve(pending);
    await submitting;
    expect(editor.snapshot().record?.id).toBe(newerId);
    expect(editor.snapshot().content).toBe("Synthetic newer editable draft");
    expect(editor.snapshot().record?.state).toBe("draft");
  });

  it("keeps a lost submit outcome read-only when the same identity cannot yet be inspected", async () => {
    const { bridge } = syntheticCaptureBridge();
    const editor = new CaptureEditor(bridge);
    await editor.initialize();
    editor.edit("content", "Synthetic response-loss note");
    await editor.flush();
    vi.mocked(bridge.submit).mockRejectedValue("capture_io");
    vi.mocked(bridge.get).mockRejectedValue("capture_io");
    await editor.submit(time, 480);
    expect(editor.snapshot().record?.state).toBe("uncertain");
    editor.edit("content", "Must not change the unresolved snapshot");
    expect(editor.snapshot().content).toBe("Synthetic response-loss note");
    await editor.newDraft();
    expect(editor.snapshot().record?.state).toBe("draft");
    expect(bridge.submit).toHaveBeenCalledOnce();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tauriCaptureBridge } from "./captureBridge";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

describe("tauriCaptureBridge", () => {
  beforeEach(() => vi.clearAllMocks());

  it("only exposes bounded inbox and own-window commands, never workspace authority", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    await tauriCaptureBridge.list();
    await tauriCaptureBridge.get(id);
    await tauriCaptureBridge.create();
    await tauriCaptureBridge.save(id, 1, "Synthetic", "Local plaintext");
    await tauriCaptureBridge.submit(id, 2, 1_788_422_400_000, 480);
    await tauriCaptureBridge.setExpanded(true);
    await tauriCaptureBridge.drag();
    await tauriCaptureBridge.exit();
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["capture_list"], ["capture_get", { id }], ["capture_create"],
      ["capture_save", { id, expectedRevision: 1, name: "Synthetic", content: "Local plaintext" }],
      ["capture_submit", { id, expectedRevision: 2, capturedAtMs: 1_788_422_400_000, utcOffsetMinutes: 480 }],
      ["capture_set_expanded", { expanded: true }], ["capture_drag"], ["capture_exit"],
    ]);
  });

  it("does not subscribe to main workspace lock or activity events", async () => {
    await tauriCaptureBridge.subscribeCloseRequested(() => undefined);
    expect(listen).toHaveBeenCalledOnce();
    expect(vi.mocked(listen).mock.calls[0][0]).toBe("capture-close-requested");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tauriCapsuleBridge } from "./capsuleBridge";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

describe("tauriCapsuleBridge", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses only capsule-scoped commands with the original owner and context", async () => {
    const context = { ownerId: "synthetic-owner", contextId: "synthetic-context" };
    const input = {
      nodeId: "11111111-1111-4111-8111-111111111111",
      name: "", content: "Synthetic note", capturedAtMs: 1_788_422_400_000, utcOffsetMinutes: 480,
    };
    await tauriCapsuleBridge.inspect();
    await tauriCapsuleBridge.submit({ ...context, input });
    await tauriCapsuleBridge.inspectSubmission({ ...context, nodeId: input.nodeId });
    await tauriCapsuleBridge.recordActivity(context);
    await tauriCapsuleBridge.setExpanded(true);
    await tauriCapsuleBridge.hide();
    await tauriCapsuleBridge.focusMain();
    await tauriCapsuleBridge.drag();
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["inspect_capsule"],
      ["submit_capsule_note", { ...context, input }],
      ["inspect_capsule_submission", { ...context, nodeId: input.nodeId }],
      ["capsule_record_activity", context],
      ["set_capsule_expanded", { expanded: true }],
      ["hide_capsule_window"],
      ["focus_main_window"],
      ["drag_capsule_window"],
    ]);
  });

  it("does not pass event payloads to capsule state or lock listeners", async () => {
    const changed = vi.fn();
    const locked = vi.fn();
    await tauriCapsuleBridge.subscribeStateChanged(changed);
    await tauriCapsuleBridge.subscribeLocked(locked);
    expect(vi.mocked(listen).mock.calls[0][0]).toBe("capsule-state-changed");
    expect(vi.mocked(listen).mock.calls[1][0]).toBe("workspace-security-locked");
    vi.mocked(listen).mock.calls[0][1]({ event: "capsule-state-changed", id: 1, payload: "ignored" });
    vi.mocked(listen).mock.calls[1][1]({ event: "workspace-security-locked", id: 2, payload: "ignored" });
    expect(changed).toHaveBeenCalledWith();
    expect(locked).toHaveBeenCalledWith();
  });
});

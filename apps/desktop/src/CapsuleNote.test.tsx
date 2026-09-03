// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CapsuleNote from "./CapsuleNote";
import type { CapsuleBridge, CapsuleState, CapsuleSubmissionResult } from "./capsuleBridge";
import i18n from "./i18n";

const ready: CapsuleState = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  contextId: "22222222-2222-4222-8222-222222222222",
  ready: true,
  encrypted: true,
};
const nodeId = "33333333-3333-4333-8333-333333333333";
const capturedAtMs = Date.parse("2026-09-03T08:00:00Z");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function fakeBridge() {
  const listeners = {
    changed: null as (() => void) | null,
    locked: null as (() => void) | null,
  };
  const bridge: CapsuleBridge = {
    inspect: vi.fn(async () => ready),
    submit: vi.fn(async () => ({ status: "queued" as const })),
    inspectSubmission: vi.fn(async () => ({ status: "processing" as const })),
    subscribeStateChanged: vi.fn(async (listener: () => void) => {
      listeners.changed = listener;
      return () => { listeners.changed = null; };
    }),
    subscribeLocked: vi.fn(async (listener: () => void) => {
      listeners.locked = listener;
      return () => { listeners.locked = null; };
    }),
    recordActivity: vi.fn(async () => undefined),
    setExpanded: vi.fn(async () => undefined),
    hide: vi.fn(async () => undefined),
    focusMain: vi.fn(async () => undefined),
    drag: vi.fn(async () => undefined),
  };
  return { bridge, listeners };
}

function enterValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEnter(input: HTMLElement, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter", bubbles: true, cancelable: true, ...options,
  });
  input.dispatchEvent(event);
  return event;
}

describe("CapsuleNote", () => {
  let container: HTMLDivElement;
  let root: Root;
  let runtime: ReturnType<typeof fakeBridge>;
  let newId: ReturnType<typeof vi.fn<() => string>>;
  let now: ReturnType<typeof vi.fn<() => number>>;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    await i18n.changeLanguage("en-US");
    vi.useFakeTimers();
    runtime = fakeBridge();
    newId = vi.fn(() => nodeId);
    now = vi.fn(() => capturedAtMs);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function render() {
    await act(async () => {
      root.render(<CapsuleNote bridge={runtime.bridge} newId={newId} now={now} utcOffsetMinutes={() => 480} />);
    });
  }

  async function expand() {
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".capsule-toggle")!.click();
    });
  }

  function editor() {
    return container.querySelector<HTMLTextAreaElement>("textarea")!;
  }

  it("starts collapsed, offers only the main-window unlock entry when unavailable", async () => {
    vi.mocked(runtime.bridge.inspect).mockResolvedValue({ ...ready, ready: false });
    await render();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector(".capsule-note")?.getAttribute("data-expanded")).toBe("false");
    await expand();
    expect(runtime.bridge.focusMain).toHaveBeenCalledOnce();
    expect(runtime.bridge.setExpanded).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("completes both subscriptions before the first state inspection", async () => {
    const subscription = deferred<() => void>();
    vi.mocked(runtime.bridge.subscribeStateChanged).mockReturnValue(subscription.promise);
    await render();
    expect(runtime.bridge.subscribeLocked).toHaveBeenCalledOnce();
    expect(runtime.bridge.subscribeStateChanged).toHaveBeenCalledOnce();
    expect(runtime.bridge.inspect).not.toHaveBeenCalled();
    await act(async () => { subscription.resolve(() => undefined); });
    expect(runtime.bridge.inspect).toHaveBeenCalledOnce();
  });

  it("never opens the editor if a required event subscription fails", async () => {
    vi.mocked(runtime.bridge.subscribeStateChanged).mockRejectedValue(new Error("unavailable"));
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(runtime.bridge.inspect).not.toHaveBeenCalled();
    expect(runtime.listeners.locked).toBeNull();
    await expand();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("coalesces Ctrl+Enter, editor blur, and window blur into one immutable submission", async () => {
    const result = deferred<CapsuleSubmissionResult>();
    vi.mocked(runtime.bridge.submit).mockReturnValue(result.promise);
    await render();
    await expand();
    act(() => {
      enterValue(editor(), "Synthetic note\nsecond line");
      pressEnter(editor(), { ctrlKey: true });
      editor().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
      window.dispatchEvent(new Event("blur"));
      pressEnter(editor(), { ctrlKey: true });
    });
    expect(runtime.bridge.submit).toHaveBeenCalledOnce();
    expect(runtime.bridge.submit).toHaveBeenCalledWith({
      ownerId: ready.ownerId,
      contextId: ready.contextId,
      input: { nodeId, name: "", content: "Synthetic note\nsecond line", capturedAtMs, utcOffsetMinutes: 480 },
    });
    expect(newId).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledOnce();
    expect(editor().readOnly).toBe(true);
    expect(editor().value).toBe("Synthetic note\nsecond line");
    await act(async () => { result.resolve({ status: "saved" }); });
    expect(editor().value).toBe("");
    expect(editor().readOnly).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Saved");
  });

  it("does not submit normal Enter, IME Enter, or focus changes inside the editing area", async () => {
    await render();
    await expand();
    const nameInput = container.querySelector<HTMLInputElement>("input")!;
    act(() => {
      enterValue(editor(), "Synthetic note");
      expect(pressEnter(editor()).defaultPrevented).toBe(false);
      expect(pressEnter(editor(), { ctrlKey: true, isComposing: true }).defaultPrevented).toBe(false);
      expect(pressEnter(editor(), { ctrlKey: true, keyCode: 229 }).defaultPrevented).toBe(false);
      editor().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      pressEnter(editor(), { ctrlKey: true });
      window.dispatchEvent(new Event("blur"));
      editor().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      editor().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: nameInput }));
      nameInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: editor() }));
    });
    expect(runtime.bridge.submit).not.toHaveBeenCalled();
    act(() => {
      nameInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(runtime.bridge.submit).toHaveBeenCalledOnce();
  });

  it("retains an editable failed draft and retries unchanged input with the same identity and time", async () => {
    vi.mocked(runtime.bridge.submit).mockResolvedValue({ status: "failed", reason: "saveFailed" });
    await render();
    await expand();
    await act(async () => {
      enterValue(editor(), "Synthetic failed draft");
      pressEnter(editor(), { ctrlKey: true });
    });
    expect(editor().value).toBe("Synthetic failed draft");
    expect(editor().readOnly).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Save failed");
    await act(async () => { pressEnter(editor(), { ctrlKey: true }); });
    const calls = vi.mocked(runtime.bridge.submit).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toEqual(calls[0][0]);
    expect(newId).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledOnce();
  });

  it("allows a confirmed failed draft to be corrected as a new immutable submission", async () => {
    vi.mocked(runtime.bridge.submit).mockResolvedValue({ status: "failed", reason: "duplicateName" });
    newId.mockReturnValueOnce(nodeId).mockReturnValueOnce("44444444-4444-4444-8444-444444444444");
    await render();
    await expand();
    await act(async () => {
      enterValue(container.querySelector<HTMLInputElement>("input")!, "Already used");
      enterValue(editor(), "Synthetic draft");
      pressEnter(editor(), { ctrlKey: true });
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("already used");
    await act(async () => {
      enterValue(container.querySelector<HTMLInputElement>("input")!, "Corrected name");
      pressEnter(editor(), { ctrlKey: true });
    });
    expect(vi.mocked(runtime.bridge.submit).mock.calls[1][0].input.nodeId).not.toBe(nodeId);
    expect(vi.mocked(runtime.bridge.submit).mock.calls[1][0].input.name).toBe("Corrected name");
  });

  it("treats a lost response as unknown and queries only the original ID until confirmed", async () => {
    vi.mocked(runtime.bridge.submit).mockRejectedValue(new Error("response lost"));
    vi.mocked(runtime.bridge.inspectSubmission)
      .mockResolvedValueOnce({ status: "unknown" })
      .mockResolvedValueOnce({ status: "saved" });
    await render();
    await expand();
    await act(async () => {
      enterValue(editor(), "Synthetic uncertain note");
      pressEnter(editor(), { ctrlKey: true });
    });
    expect(editor().readOnly).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("not confirmed");
    act(() => { pressEnter(editor(), { ctrlKey: true }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(runtime.bridge.inspectSubmission).toHaveBeenCalledWith({ ownerId: ready.ownerId, contextId: ready.contextId, nodeId });
    expect(editor().value).toBe("Synthetic uncertain note");
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(editor().value).toBe("");
    expect(runtime.bridge.submit).toHaveBeenCalledOnce();
    expect(newId).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(runtime.bridge.inspectSubmission).toHaveBeenCalledTimes(2);
    expect(runtime.bridge.recordActivity).toHaveBeenCalledOnce();
  });

  it("can recover a saved receipt even if the original submission response never arrives", async () => {
    const response = deferred<CapsuleSubmissionResult>();
    vi.mocked(runtime.bridge.submit).mockReturnValue(response.promise);
    vi.mocked(runtime.bridge.inspectSubmission).mockResolvedValue({ status: "saved" });
    await render();
    await expand();
    act(() => {
      enterValue(editor(), "Synthetic note with a missing response");
      pressEnter(editor(), { ctrlKey: true });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(editor().value).toBe("");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Saved");
    act(() => { enterValue(editor(), "A newer draft"); });
    await act(async () => { response.resolve({ status: "queued" }); });
    expect(editor().value).toBe("A newer draft");
    expect(editor().readOnly).toBe(false);
    expect(runtime.bridge.submit).toHaveBeenCalledOnce();
  });

  it("clears the draft immediately on lock and ignores late save and old-context inspection results", async () => {
    const response = deferred<CapsuleSubmissionResult>();
    const staleInspection = deferred<CapsuleState>();
    vi.mocked(runtime.bridge.submit).mockReturnValue(response.promise);
    await render();
    await expand();
    act(() => {
      enterValue(editor(), "Synthetic private draft");
      pressEnter(editor(), { ctrlKey: true });
    });
    vi.mocked(runtime.bridge.inspect).mockReturnValueOnce(staleInspection.promise);
    act(() => { runtime.listeners.changed?.(); });
    act(() => { runtime.listeners.locked?.(); });
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("Synthetic private draft");
    await act(async () => {
      response.resolve({ status: "saved" });
      staleInspection.resolve(ready);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).not.toBe("Saved");
    vi.mocked(runtime.bridge.inspect).mockResolvedValue({ ...ready, contextId: "new-unlocked-context" });
    await act(async () => { runtime.listeners.changed?.(); });
    expect(editor().value).toBe("");
    expect(editor().readOnly).toBe(false);
    expect(runtime.bridge.inspectSubmission).not.toHaveBeenCalled();
  });

  it("discards pending callbacks when a workspace context or owner changes", async () => {
    const response = deferred<CapsuleSubmissionResult>();
    vi.mocked(runtime.bridge.submit).mockReturnValue(response.promise);
    await render();
    await expand();
    act(() => {
      enterValue(editor(), "Old session draft");
      pressEnter(editor(), { ctrlKey: true });
    });
    vi.mocked(runtime.bridge.inspect).mockResolvedValue({ ...ready, ownerId: "new-owner", contextId: "new-context" });
    await act(async () => { runtime.listeners.changed?.(); });
    expect(editor().value).toBe("");
    act(() => { enterValue(editor(), "New session draft"); });
    await act(async () => { response.resolve({ status: "saved" }); });
    expect(editor().value).toBe("New session draft");
    expect(container.querySelector('[role="status"]')?.textContent).not.toBe("Saved");
  });

  it("ignores an out-of-order context probe after the next workspace is already active", async () => {
    const staleInspection = deferred<CapsuleState>();
    await render();
    await expand();
    act(() => { enterValue(editor(), "Old workspace draft"); });
    vi.mocked(runtime.bridge.inspect).mockReturnValueOnce(staleInspection.promise);
    act(() => { runtime.listeners.changed?.(); });
    vi.mocked(runtime.bridge.inspect).mockResolvedValue({ ...ready, contextId: "next-context" });
    await act(async () => { runtime.listeners.changed?.(); });
    expect(editor().value).toBe("");
    act(() => { enterValue(editor(), "Next workspace draft"); });
    await act(async () => { staleInspection.resolve(ready); });
    expect(editor().value).toBe("Next workspace draft");
    act(() => { pressEnter(editor(), { ctrlKey: true }); });
    expect(vi.mocked(runtime.bridge.submit).mock.calls[0][0].contextId).toBe("next-context");
  });

  it("polls context as an event-loss fallback without recording background activity", async () => {
    await render();
    await expand();
    act(() => { enterValue(editor(), "Synthetic draft"); });
    expect(runtime.bridge.recordActivity).toHaveBeenCalledOnce();
    vi.mocked(runtime.bridge.inspect).mockResolvedValue({ ...ready, ready: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.querySelector("textarea")).toBeNull();
    expect(runtime.bridge.recordActivity).toHaveBeenCalledOnce();
    expect(runtime.bridge.inspectSubmission).not.toHaveBeenCalled();
  });

  it("fails closed on an inspection error and does not retain the old draft when service returns", async () => {
    await render();
    await expand();
    act(() => { enterValue(editor(), "Synthetic private draft"); });
    vi.mocked(runtime.bridge.inspect).mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => { runtime.listeners.changed?.(); });
    expect(container.querySelector("textarea")).toBeNull();
    await act(async () => { runtime.listeners.changed?.(); });
    expect(editor().value).toBe("");
  });

  it("warns about plaintext storage and never writes a draft to browser storage", async () => {
    vi.mocked(runtime.bridge.inspect).mockResolvedValue({ ...ready, encrypted: false });
    const localWrite = vi.spyOn(localStorage, "setItem");
    const sessionWrite = vi.spyOn(sessionStorage, "setItem");
    await render();
    await expand();
    act(() => { enterValue(editor(), "Synthetic local-only draft"); });
    expect(container.textContent).toContain("not encrypted");
    expect(container.textContent).toContain("locking, switching workspaces, or exiting clears");
    expect(localWrite).not.toHaveBeenCalled();
    expect(sessionWrite).not.toHaveBeenCalled();
  });

  it("keeps the draft when collapsed, prevents hiding it, and hides an empty capsule without exiting", async () => {
    await render();
    await expand();
    act(() => { enterValue(editor(), "Synthetic draft"); });
    const hide = container.querySelector<HTMLButtonElement>('button[aria-label="Hide capsule (keep the application running)"]')!;
    expect(hide.disabled).toBe(true);
    expect(document.activeElement).toBe(editor());
    await act(async () => {
      const collapse = container.querySelector<HTMLButtonElement>(".capsule-toggle")!;
      const pointerDown = new PointerEvent("pointerdown", {
        button: 0, bubbles: true, cancelable: true,
      });
      collapse.dispatchEvent(pointerDown);
      // Model the browser's default focus step; it must be prevented here.
      if (!pointerDown.defaultPrevented) {
        collapse.focus();
      }
      expect(pointerDown.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(editor());
      collapse.click();
    });
    expect(runtime.bridge.setExpanded).toHaveBeenLastCalledWith(false);
    expect(runtime.bridge.submit).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("Unsaved draft");
    await expand();
    expect(editor().value).toBe("Synthetic draft");
    act(() => { enterValue(editor(), ""); });
    await act(async () => { hide.click(); });
    expect(runtime.bridge.hide).toHaveBeenCalledOnce();
  });
});

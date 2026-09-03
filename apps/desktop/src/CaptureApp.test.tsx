// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CaptureApp from "./CaptureApp";
import type { CaptureRecord } from "./captureBridge";
import { deferred, syntheticCaptureBridge } from "./captureTestSupport";
import i18n from "./i18n";

function enterValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function enter(input: HTMLElement, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
  input.dispatchEvent(event);
  return event;
}

describe("independent notes UI", () => {
  let root: Root;
  let container: HTMLDivElement;
  let runtime: ReturnType<typeof syntheticCaptureBridge>;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await i18n.changeLanguage("en-US");
    vi.useFakeTimers();
    runtime = syntheticCaptureBridge();
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
      root.render(<CaptureApp bridge={runtime.bridge} now={() => 1_788_422_400_000} utcOffsetMinutes={() => 480} />);
    });
  }

  async function click(testId: string) {
    await act(async () => { container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click(); });
  }

  function content() { return container.querySelector<HTMLTextAreaElement>("textarea")!; }

  it("opens without a main workspace, saves locally, and discloses the plaintext boundary", async () => {
    await render();
    expect(container.querySelector("textarea")).toBeNull();
    await click("capture-toggle");
    expect(content().readOnly).toBe(false);
    const browserWrite = vi.spyOn(localStorage, "setItem");
    await act(async () => { enterValue(content(), "Synthetic local draft"); });
    expect(runtime.bridge.save).toHaveBeenCalled();
    expect(runtime.bridge.submit).not.toHaveBeenCalled();
    expect(container.textContent).toContain("plaintext");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("not submitted for archiving");
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it("leaves ordinary and IME Enter alone, coalescing Ctrl+Enter and blur into one submission", async () => {
    await render();
    await click("capture-toggle");
    await act(async () => { enterValue(content(), "Line one\nline two"); });
    act(() => {
      expect(enter(content()).defaultPrevented).toBe(false);
      expect(enter(content(), { ctrlKey: true, isComposing: true }).defaultPrevented).toBe(false);
      expect(enter(content(), { ctrlKey: true, keyCode: 229 }).defaultPrevented).toBe(false);
      const name = container.querySelector<HTMLInputElement>("input")!;
      content().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: name }));
    });
    expect(runtime.bridge.submit).not.toHaveBeenCalled();
    await act(async () => {
      enter(content(), { ctrlKey: true });
      content().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
      window.dispatchEvent(new Event("blur"));
    });
    expect(runtime.bridge.submit).toHaveBeenCalledOnce();
    expect(content().readOnly).toBe(true);
    expect(content().value).toBe("Line one\nline two");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved locally; waiting to archive");
  });

  it("submits on leaving the editor, but preserves an IME composition", async () => {
    await render();
    await click("capture-toggle");
    await act(async () => { enterValue(content(), "Synthetic focus-loss note"); });
    act(() => {
      content().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      window.dispatchEvent(new Event("blur"));
      content().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(runtime.bridge.submit).not.toHaveBeenCalled();
    await act(async () => {
      content().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      content().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(runtime.bridge.submit).toHaveBeenCalledOnce();
  });

  it("keeps a claimed record read-only while another note can be created and edited", async () => {
    await render();
    await click("capture-toggle");
    await act(async () => {
      enterValue(content(), "Synthetic in-flight note");
      enter(content(), { ctrlKey: true });
    });
    const pending = [...runtime.records.values()][0];
    runtime.records.set(pending.id, { ...pending, state: "claimed" });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(content().readOnly).toBe(true);
    expect(container.querySelector('[data-testid="capture-edit"]')).toBeNull();
    await click("capture-new");
    expect(content().readOnly).toBe(false);
    await act(async () => { enterValue(content(), "Synthetic next draft"); });
    expect(runtime.records.get(pending.id)?.content).toBe("Synthetic in-flight note");
    expect(content().value).toBe("Synthetic next draft");
  });

  it("keeps pending editing disabled until withdrawal CAS confirms", async () => {
    await render();
    await click("capture-toggle");
    await act(async () => {
      enterValue(content(), "Synthetic pending note");
      enter(content(), { ctrlKey: true });
    });
    const pending = [...runtime.records.values()][0];
    const withdrawn = deferred<CaptureRecord>();
    vi.mocked(runtime.bridge.save).mockReturnValueOnce(withdrawn.promise);
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="capture-edit"]')!.click(); });
    expect(content().readOnly).toBe(true);
    await act(async () => { withdrawn.resolve({ ...pending, state: "draft", revision: pending.revision + 1 }); });
    expect(content().readOnly).toBe(false);
  });

  it("collapses after local saving without submitting or erasing the draft", async () => {
    await render();
    await click("capture-toggle");
    await act(async () => { enterValue(content(), "Synthetic collapsed draft"); });
    await click("capture-toggle");
    expect(runtime.bridge.submit).not.toHaveBeenCalled();
    expect(runtime.bridge.setExpanded).toHaveBeenLastCalledWith(false);
    await click("capture-toggle");
    expect(content().value).toBe("Synthetic collapsed draft");
  });

  it("waits for a local save before exiting only the note application", async () => {
    await render();
    await click("capture-toggle");
    const save = deferred<CaptureRecord>();
    vi.mocked(runtime.bridge.save).mockReturnValueOnce(save.promise);
    act(() => { enterValue(content(), "Synthetic exit draft"); });
    act(() => { for (const close of runtime.closed) close(); });
    expect(runtime.bridge.exit).not.toHaveBeenCalled();
    const original = [...runtime.records.values()][0];
    await act(async () => { save.resolve({ ...original, revision: original.revision + 1, content: "Synthetic exit draft" }); });
    expect(runtime.bridge.exit).toHaveBeenCalledOnce();
    expect(runtime.bridge.submit).not.toHaveBeenCalled();
  });

  it("polls archive receipts without clearing a newer selected draft", async () => {
    await render();
    await click("capture-toggle");
    await act(async () => {
      enterValue(content(), "Synthetic archived note");
      enter(content(), { ctrlKey: true });
    });
    const pending = [...runtime.records.values()][0];
    await click("capture-new");
    await act(async () => { enterValue(content(), "Synthetic newer draft"); });
    runtime.records.set(pending.id, { ...pending, state: "archived", name: "", content: "" });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(content().value).toBe("Synthetic newer draft");
    expect(container.querySelectorAll(".capture-list button")).toHaveLength(1);
  });
});

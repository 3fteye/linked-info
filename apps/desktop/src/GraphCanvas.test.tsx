// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import {
  InformationNodeCard,
  finalizeNodeDragLayout,
} from "./GraphCanvas";

const nodeId = "11111111-1111-4111-8111-111111111111";

function enterInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function cardProps(overrides: Record<string, unknown> = {}): NodeProps<any> {
  return {
    id: nodeId,
    type: "information",
    selected: false,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: false,
    isConnectable: true,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    data: {
      name: "Node",
      content: "a".repeat(2_000),
      contentFullyRendered: true,
      contentTruncated: false,
      contentProcessorId: null,
      codeSourceContainsSensitive: false,
      contentProcessorLabel: "Content format",
      contentProcessorOptions: [
        { id: "text", label: "Plain text" },
        { id: "markdown", label: "Markdown" },
        { id: "code.typescript", label: "TypeScript" },
      ],
      contentMarkerOptions: [
        { id: "totp", invalidPayloadLabel: "Invalid TOTP secret", label: "TOTP" },
        { id: "secret", invalidPayloadLabel: null, label: "Secret" },
      ],
      editMarkerLabel: (markerLabel: string) => `Current marker: ${markerLabel}`,
      markSelectionLabel: "Mark selection",
      markerNoteLabel: "Description",
      markerNotePlaceholder: "For example: OpenAI | Sign-in password",
      markerPayloadInvalidLabel: (markerLabel: string) =>
        `Invalid ${markerLabel} payload`,
      markerSelectionConflictLabel: "Selection crosses marker boundaries",
      manualHeight: false,
      manualSize: false,
      manualWidth: false,
      removeMarkerLabel: "Remove marker",
      saveMarkerNoteLabel: "Save description",
      fitNodeContentLabel: "Fit content",
      unsupportedContentProcessorLabel: (processorId: string) =>
        `Unavailable: ${processorId}`,
      contentLabel: "Content",
      contentPlaceholder: "Content",
      enhancementLabels: {
        code: {
          copy: "Copy source",
          languages: {
            powershell: "PowerShell",
            bash: "Bash",
            python: "Python",
            javascript: "JavaScript",
            typescript: "TypeScript",
            rust: "Rust",
            json: "JSON",
            yaml: "YAML",
            sql: "SQL",
          },
          truncated: "Preview truncated",
        },
        secret: {
          copy: "Copy secret",
          hide: "Hide",
          label: "Secret",
          masked: "Hidden",
          reveal: "Reveal",
        },
        totp: {
          copy: "Copy code",
          generating: "Generating",
          invalid: "Invalid TOTP secret",
          masked: "Secret hidden",
          remaining: (seconds: number) => `${seconds}s`,
        },
      },
      editing: true,
      interactive: true,
      nameConflict: false,
      nameConflictLabel: "Conflict",
      nameLabel: "Name",
      namePlaceholder: "Name",
      incomingReferenceCount: 0,
      incomingReferencesLabel: "Referenced by 0 nodes",
      referencedTargets: [],
      collapsedIncomingReferenceLabel: null,
      referencesLabel: "References",
      unnamedLabel: "Unnamed",
      filterActive: false,
      filterByNodeLabel: "Filter",
      removeNodeFilterLabel: "Remove filter",
      removeReferenceLabel: (name: string) => `Remove reference: ${name}`,
      sourceLabel: "Source",
      targetLabel: "Target",
      onBrowseIncomingReferences: vi.fn(),
      onCommit: vi.fn(),
      onContentChange: vi.fn(),
      onContentProcessorChange: vi.fn(),
      onExtensionMetadataChange: vi.fn(),
      onExtensionProposal: vi.fn(),
      onRemoveReference: vi.fn(),
      onCopyCodeSource: vi.fn(),
      onCopyDerivedSecret: null,
      onFitNodeContent: vi.fn(),
      onNameChange: vi.fn(() => true),
      onResizeEnd: vi.fn(),
      onResizeStart: vi.fn(),
      onToggleReferenceFilter: vi.fn(),
      ...overrides,
    },
  } as NodeProps<any>;
}

function input(
  element: HTMLTextAreaElement | HTMLInputElement,
  value: string,
  caret = value.length,
) {
  const descriptor = Object.getOwnPropertyDescriptor(
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    "value",
  );
  descriptor?.set?.call(element, value);
  element.setSelectionRange(caret, caret);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function renderCard(root: Root, props: NodeProps<any>) {
  act(() =>
    root.render(
      <ReactFlowProvider>
        <InformationNodeCard {...props} />
      </ReactFlowProvider>,
    ),
  );
}

describe("InformationNodeCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("preserves the caret while editing long content in the middle", () => {
    const props = cardProps();
    renderCard(root, props);
    const textarea = container.querySelector("textarea")!;
    textarea.focus();
    textarea.setSelectionRange(1, 1);

    const edited = `${textarea.value.slice(0, 1)}x${textarea.value.slice(1)}`;
    act(() => input(textarea, edited, 2));
    renderCard(root, cardProps({ content: edited }));

    expect(textarea.selectionStart).toBe(2);
    expect(props.data.onContentChange).toHaveBeenLastCalledWith(
      nodeId,
      expect.stringMatching(/^ax/),
    );
  });

  it("preserves Enter, Shift+Enter, and Backspace results at the caret", () => {
    const props = cardProps({ content: "ab" });
    renderCard(root, props);
    const textarea = container.querySelector("textarea")!;
    textarea.focus();

    act(() => input(textarea, "a\nb"));
    expect(textarea.value).toBe("a\nb");
    act(() => input(textarea, "a\n\nb"));
    expect(textarea.value).toBe("a\n\nb");
    act(() => input(textarea, "a\nb"));
    expect(textarea.value).toBe("a\nb");
  });

  it("does not commit while focus moves between fields inside the node", () => {
    vi.useFakeTimers();
    const props = cardProps({ content: "content" });
    renderCard(root, props);
    const name = container.querySelector("input")!;
    const textarea = container.querySelector("textarea")!;

    act(() => {
      name.focus();
      textarea.focus();
      vi.runAllTimers();
    });

    expect(props.data.onCommit).not.toHaveBeenCalled();
  });

  it("does not steal focus back from content after the user enters a new editor", () => {
    vi.useFakeTimers();
    renderCard(root, cardProps({ content: "content" }));
    const textarea = container.querySelector("textarea")!;

    act(() => {
      textarea.focus();
      vi.runAllTimers();
    });

    expect(document.activeElement).toBe(textarea);
  });

  it("changes the content processor without leaving the node editor", () => {
    vi.useFakeTimers();
    const props = cardProps({ content: "# Heading" });
    renderCard(root, props);
    act(() => vi.runAllTimers());
    let select = container.querySelector("select")!;

    act(() => {
      select.focus();
      select.value = "markdown";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    renderCard(root, {
      ...props,
      data: { ...props.data, contentProcessorId: "markdown" },
    });
    select = container.querySelector("select")!;
    act(() => {
      select.blur();
      vi.runAllTimers();
    });

    expect(props.data.onContentProcessorChange).toHaveBeenCalledWith(
      nodeId,
      "markdown",
    );
    expect(props.data.onCommit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(select);

    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      select.blur();
      vi.runAllTimers();
    });
    expect(props.data.onCommit).toHaveBeenCalledWith(nodeId);
  });

  it("wraps only the selected content with the chosen extensible marker", () => {
    vi.useFakeTimers();
    const content = "2FA jbsw y3dp ehpk 3pxp, note";
    const props = cardProps({ content });
    renderCard(root, props);
    act(() => vi.runAllTimers());
    const textarea = container.querySelector("textarea")!;
    const start = content.indexOf("jbsw");
    const end = content.indexOf(", note");

    act(() => {
      textarea.focus();
      textarea.setSelectionRange(start, end);
      textarea.dispatchEvent(new Event("mouseup", { bubbles: true }));
    });
    const markerToolbar = container.querySelector(
      ".graph-node-content-marker-toolbar",
    );
    expect(markerToolbar?.textContent).toContain("TOTP");
    const totpButton = Array.from(markerToolbar?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "TOTP",
    );
    act(() => totpButton?.click());
    act(() => vi.runAllTimers());

    const marked = "2FA [[li:totp]]jbsw y3dp ehpk 3pxp[[/li]], note";
    expect(textarea.value).toBe(marked);
    expect(props.data.onContentChange).toHaveBeenCalledWith(nodeId, marked);
    expect(document.activeElement).toBe(
      container.querySelector('.graph-node-content-marker-note-input'),
    );
  });

  it("writes and edits a marker description inside the portable source", () => {
    vi.useFakeTimers();
    const content = "API synthetic-api-key";
    const props = cardProps({ content });
    renderCard(root, props);
    act(() => vi.runAllTimers());
    const textarea = container.querySelector("textarea")!;
    const start = content.indexOf("synthetic");

    act(() => {
      textarea.focus();
      textarea.setSelectionRange(start, content.length);
      textarea.dispatchEvent(new Event("mouseup", { bubbles: true }));
    });
    const secret = Array.from(
      container.querySelectorAll(".graph-node-content-marker-toolbar button"),
    ).find((button) => button.textContent === "Secret");
    act(() => (secret as HTMLButtonElement | undefined)?.click());
    act(() => vi.runAllTimers());

    const noteInput = container.querySelector<HTMLInputElement>(
      '.graph-node-content-marker-note-input[aria-label="Description"]',
    )!;
    act(() => {
      enterInputValue(noteInput, "OpenAI | API Key");
    });
    const save = Array.from(
      container.querySelectorAll(".graph-node-content-marker-toolbar button"),
    ).find((button) => button.textContent === "Save description");
    act(() => (save as HTMLButtonElement | undefined)?.click());
    act(() => vi.runAllTimers());

    const marked =
      'API [[li:secret note="OpenAI | API Key"]]synthetic-api-key[[/li]]';
    expect(textarea.value).toBe(marked);
    expect(props.data.onContentChange).toHaveBeenLastCalledWith(nodeId, marked);
  });

  it("captures a keyboard range once when Shift is released", () => {
    const content = "API synthetic-secret retained";
    renderCard(root, cardProps({ content }));
    const textarea = container.querySelector("textarea")!;
    const start = content.indexOf("synthetic-secret");

    act(() => {
      textarea.focus();
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Shift" }),
      );
      textarea.setSelectionRange(start, start + "synthetic-secret".length);
      textarea.dispatchEvent(
        new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }),
      );
    });

    expect(
      container.querySelector('.graph-node-content-marker-toolbar[aria-label="Mark selection"]'),
    ).not.toBeNull();
  });

  it("recognizes an existing marker at the caret and changes its complete type", () => {
    vi.useFakeTimers();
    const content = "2FA [[li:secret]]JBSW Y3DP EHPK 3PXP[[/li]], note";
    const props = cardProps({ content });
    renderCard(root, props);
    act(() => vi.runAllTimers());
    const textarea = container.querySelector("textarea")!;
    const caret = content.indexOf("Y3DP");

    act(() => {
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
      textarea.dispatchEvent(new Event("mouseup", { bubbles: true }));
    });
    const toolbar = container.querySelector(
      '.graph-node-content-marker-toolbar[aria-label="Current marker: Secret"]',
    );
    expect(toolbar).not.toBeNull();
    expect(
      (Array.from(toolbar!.querySelectorAll("button")).find(
        (button) => button.textContent === "Secret",
      ) as HTMLButtonElement).disabled,
    ).toBe(true);

    const totpButton = Array.from(toolbar!.querySelectorAll("button")).find(
      (button) => button.textContent === "TOTP",
    );
    act(() => totpButton?.click());
    act(() => vi.runAllTimers());

    const changed = "2FA [[li:totp]]JBSW Y3DP EHPK 3PXP[[/li]], note";
    expect(textarea.value).toBe(changed);
    expect(props.data.onContentChange).toHaveBeenCalledWith(nodeId, changed);
  });

  it("removes only the marker wrapper and keeps the decoded payload", () => {
    vi.useFakeTimers();
    const content = String.raw`API [[li:secret]]prefix\\\[[/li]]suffix[[/li]], note`;
    const props = cardProps({ content });
    renderCard(root, props);
    act(() => vi.runAllTimers());
    const textarea = container.querySelector("textarea")!;
    const caret = content.indexOf("prefix") + 2;

    act(() => {
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
      textarea.dispatchEvent(new Event("mouseup", { bubbles: true }));
    });
    const remove = Array.from(
      container.querySelectorAll(".graph-node-content-marker-toolbar button"),
    ).find((button) => button.textContent === "Remove marker");
    act(() => (remove as HTMLButtonElement | undefined)?.click());
    act(() => vi.runAllTimers());

    expect(textarea.value).toBe(String.raw`API prefix\[[/li]]suffix, note`);
    expect(props.data.onContentChange).toHaveBeenCalledWith(
      nodeId,
      String.raw`API prefix\[[/li]]suffix, note`,
    );
  });

  it("rejects invalid TOTP selections without changing the draft", () => {
    const content = "API synthetic-api-key";
    const props = cardProps({ content });
    renderCard(root, props);
    const textarea = container.querySelector("textarea")!;
    const start = content.indexOf("synthetic");

    act(() => {
      textarea.focus();
      textarea.setSelectionRange(start, content.length);
      textarea.dispatchEvent(new Event("mouseup", { bubbles: true }));
    });
    const totp = Array.from(
      container.querySelectorAll(".graph-node-content-marker-toolbar button"),
    ).find((button) => button.textContent === "TOTP");
    act(() => (totp as HTMLButtonElement | undefined)?.click());

    expect(textarea.value).toBe(content);
    expect(props.data.onContentChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Invalid TOTP secret",
    );
  });

  it("rejects a selection that crosses a marker boundary", () => {
    const content = "before [[li:secret]]value[[/li]] after";
    const props = cardProps({ content });
    renderCard(root, props);
    const textarea = container.querySelector("textarea")!;

    act(() => {
      textarea.focus();
      textarea.setSelectionRange(content.indexOf("before"), content.indexOf(" after"));
      textarea.dispatchEvent(new Event("mouseup", { bubbles: true }));
    });

    expect(container.querySelector(".graph-node-content-marker-toolbar")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Selection crosses marker boundaries",
    );
    expect(props.data.onContentChange).not.toHaveBeenCalled();
  });

  it("accepts a whole-line selection whose only marker padding is whitespace", () => {
    const content = "[[li:secret]]synthetic-value[[/li]]\nnext line";
    renderCard(root, cardProps({ content }));
    const textarea = container.querySelector("textarea")!;

    act(() => {
      textarea.focus();
      textarea.setSelectionRange(0, content.indexOf("next line"));
      textarea.dispatchEvent(new Event("mouseup", { bubbles: true }));
    });

    expect(
      container.querySelector(
        '.graph-node-content-marker-toolbar[aria-label="Current marker: Secret"]',
      ),
    ).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("opens incoming reference browsing while preserving the folded-edge hint", () => {
    const props = cardProps({
      collapsedIncomingReferenceLabel: "182 incoming references folded",
      editing: false,
      incomingReferenceCount: 182,
      incomingReferencesLabel: "Referenced by 182 nodes",
    });
    renderCard(root, props);

    const button = container.querySelector<HTMLButtonElement>(
      ".graph-node-incoming-button",
    )!;
    expect(button.textContent).toContain("Referenced by 182 nodes");
    expect(button.title).toBe("182 incoming references folded");
    act(() => button.click());
    expect(props.data.onBrowseIncomingReferences).toHaveBeenCalledWith(
      nodeId,
      expect.objectContaining({ bottom: 0, left: 0, top: 0 }),
    );
  });

  it("removes an outgoing reference directly from its node chip", () => {
    const targetId = "22222222-2222-4222-8222-222222222222";
    const props = cardProps({
      editing: false,
      referencedTargets: [
        { filterActive: false, id: targetId, label: "OpenAI" },
      ],
    });
    renderCard(root, props);

    const remove = container.querySelector<HTMLButtonElement>(
      '.graph-node-reference-remove[aria-label="Remove reference: OpenAI"]',
    )!;
    act(() => remove.click());

    expect(props.data.onRemoveReference).toHaveBeenCalledWith(nodeId, targetId);
    expect(props.data.onToggleReferenceFilter).not.toHaveBeenCalled();
  });

  it("loads full content only when a preview node enters editing", () => {
    const fullContent = "x".repeat(10_000);
    renderCard(
      root,
      cardProps({
        content: `${fullContent.slice(0, 600)}…`,
        editing: false,
      }),
    );

    renderCard(root, cardProps({ content: fullContent, editing: true }));

    expect(container.querySelector("textarea")?.value).toBe(fullContent);
  });
});

describe("finalizeNodeDragLayout", () => {
  it("stores all moved positions and brings the initiating node to front once", () => {
    const layout = [
      { nodeId: "a", x: 0, y: 0 },
      { nodeId: "b", x: 10, y: 10 },
      { nodeId: "c", x: 20, y: 20 },
    ];

    expect(
      finalizeNodeDragLayout(
        layout,
        [
          { id: "a", position: { x: 100, y: 110 } },
          { id: "b", position: { x: 120, y: 130 } },
        ],
        "a",
      ),
    ).toEqual([
      { nodeId: "b", x: 120, y: 130 },
      { nodeId: "c", x: 20, y: 20 },
      { nodeId: "a", x: 100, y: 110 },
    ]);
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import {
  InformationNodeCard,
  finalizeNodeDragLayout,
  renderedEdgesForViewportGesture,
} from "./GraphCanvas";

const nodeId = "11111111-1111-4111-8111-111111111111";

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
      contentProcessorId: null,
      contentLabel: "Content",
      contentPlaceholder: "Content",
      editing: true,
      nameConflict: false,
      nameConflictLabel: "Conflict",
      nameLabel: "Name",
      namePlaceholder: "Name",
      referencedTargets: [],
      collapsedIncomingReferenceLabel: null,
      referencesLabel: "References",
      unnamedLabel: "Unnamed",
      filterActive: false,
      filterByNodeLabel: "Filter",
      removeNodeFilterLabel: "Remove filter",
      sourceLabel: "Source",
      targetLabel: "Target",
      onCommit: vi.fn(),
      onContentChange: vi.fn(),
      onNameChange: vi.fn(() => true),
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

  it("shows when dense incoming edges are folded by the canvas view", () => {
    renderCard(
      root,
      cardProps({
        collapsedIncomingReferenceLabel: "182 incoming references folded",
        editing: false,
      }),
    );

    expect(container.textContent).toContain("182 incoming references folded");
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

describe("renderedEdgesForViewportGesture", () => {
  it("pauses edge rendering only while the viewport is moving", () => {
    const edges = [{ id: "a-b", source: "a", target: "b" }];

    expect(renderedEdgesForViewportGesture(edges, false)).toBe(edges);
    expect(renderedEdgesForViewportGesture(edges, true)).toEqual([]);
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionPresentationHost } from "./extensionPresentation";

const codeLanguages = {
  powershell: "PowerShell",
  bash: "Bash",
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  rust: "Rust",
  json: "JSON",
  yaml: "YAML",
  sql: "SQL",
} as const;

describe("ExtensionPresentationHost", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

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
  });

  it("renders the declared element set as escaped host UI and routes only actions", () => {
    const onAction = vi.fn();
    act(() =>
      root.render(
        <ExtensionPresentationHost
          actionLabelKey={(actionId) =>
            actionId === "refresh" ? "action.refresh" : null
          }
          labels={{
            code: {
              copy: "Copy",
              languages: codeLanguages,
              truncated: "Truncated",
            },
            resolve: (key) =>
              ({
                "action.refresh": "Refresh",
                "mode.label": "Mode",
                "mode.safe": "Safe",
              })[key] ?? null,
          }}
          onAction={onAction}
          presentation={{
            elements: [
              { type: "text", text: "<script>blocked()</script>" },
              {
                type: "key-value",
                items: [{ key: "Key", value: "Value" }],
              },
              {
                type: "table",
                columns: ["Column"],
                rows: [["Cell"]],
              },
              { type: "badge", text: "Ready", tone: "positive" },
              { type: "divider" },
              { type: "button", actionId: "refresh" },
              {
                type: "select",
                actionId: "set-mode",
                labelKey: "mode.label",
                selected: "safe",
                options: [{ value: "safe", labelKey: "mode.safe" }],
              },
            ],
          }}
          variant="canvas"
        />,
      ),
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>blocked()</script>");
    expect(container.querySelector("dl")?.textContent).toContain("KeyValue");
    expect(container.querySelector("table")?.textContent).toContain("ColumnCell");
    expect(container.querySelector('[data-tone="positive"]')?.textContent).toBe(
      "Ready",
    );
    act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(onAction).toHaveBeenCalledWith("refresh", null);
    const select = container.querySelector<HTMLSelectElement>("select")!;
    act(() => select.dispatchEvent(new Event("change", { bubbles: true })));
    expect(onAction).toHaveBeenCalledWith("set-mode", "safe");
  });

  it("omits controls and compactly flattens data in list mode", () => {
    act(() =>
      root.render(
        <ExtensionPresentationHost
          actionLabelKey={() => "action.refresh"}
          labels={{
            code: {
              copy: "Copy",
              languages: codeLanguages,
              truncated: "Truncated",
            },
            resolve: () => "Label",
          }}
          presentation={{
            elements: [
              { type: "code", language: "json", source: '{"value":1}' },
              { type: "button", actionId: "refresh" },
            ],
          }}
          variant="list"
        />,
      ),
    );

    expect(container.textContent).toBe('{"value":1}');
    expect(container.querySelector("button")).toBeNull();
  });
});

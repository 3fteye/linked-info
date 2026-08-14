// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeContentHost } from "./contentProcessor";

describe("NodeContentHost", () => {
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
  });

  it("renders Markdown without enabling HTML, navigation, or remote images", () => {
    act(() =>
      root.render(
        <NodeContentHost
          content={[
            "# Heading",
            "",
            "**Bold**",
            "",
            "<script>raw secret</script>",
            "",
            "[link](https://example.com)",
            "",
            "![remote image](https://example.com/image.png)",
          ].join("\n")}
          processorId="markdown"
          variant="canvas"
        />,
      ),
    );

    expect(container.querySelector("h1")?.textContent).toBe("Heading");
    expect(container.querySelector("strong")?.textContent).toBe("Bold");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("raw secret");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector(".markdown-link-text")?.textContent).toBe("link");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".markdown-image-placeholder")?.textContent).toBe(
      "[remote image]",
    );
  });

  it("keeps list rows compact and falls back safely for unavailable processors", () => {
    act(() =>
      root.render(
        <NodeContentHost
          content="# Raw summary"
          processorId="plugin.unavailable"
          variant="list"
        />,
      ),
    );

    const host = container.querySelector(".node-content-host");
    expect(host?.tagName).toBe("SPAN");
    expect(host?.textContent).toBe("# Raw summary");
    expect(host?.getAttribute("data-content-processor")).toBe("text");
    expect(host?.getAttribute("data-content-processor-supported")).toBe("false");
    expect(host?.getAttribute("data-requested-content-processor")).toBe(
      "plugin.unavailable",
    );
  });
});

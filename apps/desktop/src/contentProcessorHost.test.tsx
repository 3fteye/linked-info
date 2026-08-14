// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentEnhancerRegistry } from "./contentEnhancer";
import { NodeContentHost } from "./contentProcessor";

const enhancementLabels = {
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
};

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
          enhancementLabels={enhancementLabels}
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
          enhancementLabels={enhancementLabels}
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

  it("replaces only an explicit TOTP line and never exposes its secret in canvas text", () => {
    act(() =>
      root.render(
        <NodeContentHost
          content={[
            "Account: synthetic@example.test",
            "TOTP: jbsw y3dp ehpk 3pxp",
            "Note: retained",
          ].join("\n")}
          enhancementLabels={enhancementLabels}
          processorId={null}
          variant="canvas"
        />,
      ),
    );

    expect(container.querySelector(".totp-content-line")).not.toBeNull();
    expect(container.textContent).toContain("Account: synthetic@example.test");
    expect(container.textContent).toContain("Note: retained");
    expect(container.textContent).not.toContain("jbsw");
  });

  it("masks TOTP secrets in compact list rows", () => {
    const content = "Account\nTOTP: jbsw y3dp ehpk 3pxp";
    expect(
      contentEnhancerRegistry.segment(content, false).map((segment) => segment.kind),
    ).toEqual(["text", "totp"]);
    act(() =>
      root.render(
        <NodeContentHost
          content={content}
          enhancementLabels={enhancementLabels}
          processorId={null}
          variant="list"
        />,
      ),
    );

    expect(container.textContent).toContain("TOTP: Secret hidden");
    expect(container.textContent).not.toContain("jbsw");
  });

  it("renders inline TOTP and secret markers without exposing their payloads", () => {
    const content = [
      "2FA [[li:totp]]jbsw y3dp ehpk 3pxp[[/li]], note",
      "API [[li:secret]]synthetic-api-key[[/li]]",
    ].join("\n");
    act(() =>
      root.render(
        <NodeContentHost
          content={content}
          enhancementLabels={enhancementLabels}
          processorId={null}
          variant="canvas"
        />,
      ),
    );

    expect(container.querySelector(".totp-content-line")).not.toBeNull();
    expect(container.querySelector(".secret-content")).not.toBeNull();
    expect(container.textContent).toContain("2FA ");
    expect(container.textContent).toContain(", note");
    expect(container.textContent).not.toContain("jbsw");
    expect(container.textContent).not.toContain("synthetic-api-key");
  });

  it("masks every known sensitive marker in compact list rows", () => {
    act(() =>
      root.render(
        <NodeContentHost
          content="API [[li:secret]]synthetic-api-key[[/li]]"
          enhancementLabels={enhancementLabels}
          processorId={null}
          variant="list"
        />,
      ),
    );

    expect(container.textContent).toBe("API Secret: Hidden");
    expect(container.textContent).not.toContain("synthetic-api-key");
  });
});

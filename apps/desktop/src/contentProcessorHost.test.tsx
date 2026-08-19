// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentEnhancerRegistry } from "./contentEnhancer";
import { NodeContentHost } from "./contentProcessor";

const enhancementLabels = {
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

  it("renders an explicitly selected code language with line numbers and source copy", async () => {
    const source = "const answer: number = 42;\nconsole.log(answer);";
    const onCopyText = vi.fn();
    await import("./codePreview");
    await act(async () => {
      root.render(
        <NodeContentHost
          content={source}
          enhancementLabels={enhancementLabels}
          onCopyText={onCopyText}
          processorId="code.typescript"
          variant="canvas"
        />,
      );
    });

    expect(container.querySelector(".code-preview")?.getAttribute("data-language")).toBe(
      "typescript",
    );
    expect(container.querySelectorAll(".code-preview-line")).toHaveLength(2);
    expect(container.querySelector(".token.keyword")?.textContent).toBe("const");
    expect(container.textContent).toContain("TypeScript");

    act(() =>
      container
        .querySelector<HTMLButtonElement>(".code-preview-copy")
        ?.click(),
    );
    expect(onCopyText).toHaveBeenCalledWith(source);
  });

  it("masks marked secrets before highlighting and routes source copy through the secret boundary", async () => {
    const source =
      'const apiKey = "[[li:secret note="API Key"]]synthetic-secret[[/li]]";';
    const onCopySecret = vi.fn();
    const onCopyText = vi.fn();
    await import("./codePreview");
    await act(async () => {
      root.render(
        <NodeContentHost
          content={source}
          enhancementLabels={enhancementLabels}
          onCopySecret={onCopySecret}
          onCopyText={onCopyText}
          processorId="code.javascript"
          variant="canvas"
        />,
      );
    });

    expect(container.textContent).toContain("API Key");
    expect(container.textContent).not.toContain("synthetic-secret");
    act(() =>
      container
        .querySelector<HTMLButtonElement>(".code-preview-copy")
        ?.click(),
    );
    expect(onCopySecret).toHaveBeenCalledWith(source);
    expect(onCopyText).not.toHaveBeenCalled();
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
      '2FA [[li:totp note="OpenAI｜2FA"]]jbsw y3dp ehpk 3pxp[[/li]], note',
      'API [[li:secret note="GitHub｜API Key"]]synthetic-api-key[[/li]]',
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
    expect(container.textContent).toContain("OpenAI｜2FA");
    expect(container.textContent).toContain("GitHub｜API Key");
    expect(container.textContent).toContain(", note");
    expect(container.textContent).not.toContain("jbsw");
    expect(container.textContent).not.toContain("synthetic-api-key");
  });

  it("masks every known sensitive marker in compact list rows", () => {
    act(() =>
      root.render(
        <NodeContentHost
          content={'API [[li:secret note="GitHub｜API Key"]]synthetic-api-key[[/li]]'}
          enhancementLabels={enhancementLabels}
          processorId={null}
          variant="list"
        />,
      ),
    );

    expect(container.textContent).toBe("API GitHub｜API Key: Secret: Hidden");
    expect(container.textContent).not.toContain("synthetic-api-key");
  });

  it("fails closed when a known sensitive marker has malformed metadata", () => {
    act(() =>
      root.render(
        <NodeContentHost
          content="API [[li:secret note=broken]]synthetic-api-key[[/li]]"
          enhancementLabels={enhancementLabels}
          processorId={null}
          variant="canvas"
        />,
      ),
    );

    expect(container.querySelector(".secret-content")).not.toBeNull();
    expect(container.textContent).not.toContain("synthetic-api-key");
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentEnhancerRegistry } from "./contentEnhancer";
import { NodeContentHost } from "./contentProcessor";
import {
  builtInJsonInspectorExtensionId,
  builtInJsonInspectorProcessorId,
} from "./builtinJsonInspector";

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
    truncated: "Preview truncated",
  },
  extension: {
    resolve: (key: string) =>
      ({
        "indent.label": "Indentation",
        "indent.two": "2 spaces",
        "indent.four": "4 spaces",
      })[key] ?? null,
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
    const onCopyCodeSource = vi.fn();
    await import("./codePreview");
    await act(async () => {
      root.render(
        <NodeContentHost
          content={source}
          enhancementLabels={enhancementLabels}
          onCopyCodeSource={onCopyCodeSource}
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
    expect(container.querySelector(".code-preview-scroll")?.classList).toContain(
      "nodrag",
    );
    expect(container.querySelector(".code-preview-scroll")?.classList).toContain(
      "nowheel",
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>(".code-preview-copy")
        ?.click(),
    );
    expect(onCopyCodeSource).toHaveBeenCalledWith(false);
  });

  it("renders the built-in JSON adapter through declarative UI and stores its action result", async () => {
    const onExtensionMetadataChange = vi.fn();
    await import("./codePreview");
    await act(async () => {
      root.render(
        <NodeContentHost
          content={'{"outer":{"value":1}}'}
          enhancementLabels={enhancementLabels}
          extensionMetadata={{ node: {}, schemaVersion: 1, workspace: {} }}
          onExtensionMetadataChange={onExtensionMetadataChange}
          processorId={builtInJsonInspectorProcessorId}
          variant="canvas"
        />,
      );
    });

    expect(container.querySelector(".extension-presentation")).not.toBeNull();
    expect(container.querySelector(".code-preview")?.getAttribute("data-language"))
      .toBe("json");
    expect(container.textContent).toContain('"outer"');
    expect(container.textContent).toContain("Indentation");
    const select = container.querySelector<HTMLSelectElement>(
      ".extension-presentation-select select",
    )!;
    act(() => {
      select.value = "4";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onExtensionMetadataChange).toHaveBeenCalledWith(
      builtInJsonInspectorExtensionId,
      1,
      { indentSize: 4 },
      null,
    );
  });

  it("never exposes marked secrets to an extension-backed processor", async () => {
    await import("./codePreview");
    await act(async () => {
      root.render(
        <NodeContentHost
          content={
            '{"apiKey":"[[li:secret note=\"API key\"]]synthetic-secret[[/li]]"}'
          }
          enhancementLabels={enhancementLabels}
          processorId={builtInJsonInspectorProcessorId}
          variant="canvas"
        />,
      );
    });

    expect(container.textContent).toContain("API key");
    expect(container.textContent).not.toContain("synthetic-secret");
  });

  it("keeps extension-backed list rows compact and non-interactive", () => {
    act(() =>
      root.render(
        <NodeContentHost
          content={'{"value":1}'}
          enhancementLabels={enhancementLabels}
          processorId={builtInJsonInspectorProcessorId}
          variant="list"
        />,
      ),
    );

    expect(container.textContent).toContain('"value"');
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("keeps the list empty-content fallback for extension processors", () => {
    act(() =>
      root.render(
        <NodeContentHost
          content={null}
          emptyContent="No content"
          enhancementLabels={enhancementLabels}
          processorId={builtInJsonInspectorProcessorId}
          variant="list"
        />,
      ),
    );

    expect(container.querySelector(".node-content-host")?.tagName).toBe("SPAN");
    expect(container.textContent).toBe("No content");
  });

  it("masks marked secrets before highlighting and routes source copy through the secret boundary", async () => {
    const source =
      'const apiKey = "[[li:secret note="API Key"]]synthetic-secret[[/li]]";';
    const onCopyCodeSource = vi.fn();
    await import("./codePreview");
    await act(async () => {
      root.render(
        <NodeContentHost
          codeSourceContainsSensitive
          content={source}
          enhancementLabels={enhancementLabels}
          onCopyCodeSource={onCopyCodeSource}
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
    expect(onCopyCodeSource).toHaveBeenCalledWith(true);
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

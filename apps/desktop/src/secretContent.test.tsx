// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretContent, type SecretContentLabels } from "./secretContent";

const labels: SecretContentLabels = {
  copy: "Copy",
  hide: "Hide",
  label: "Secret",
  masked: "Hidden",
  reveal: "Reveal",
};

describe("SecretContent", () => {
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

  it("masks by default and only exposes the selected value after an explicit action", () => {
    const onCopySecret = vi.fn();
    act(() =>
      root.render(
        <SecretContent
          labels={labels}
          onCopySecret={onCopySecret}
          value="synthetic-secret"
        />,
      ),
    );

    expect(container.textContent).not.toContain("synthetic-secret");
    const buttons = container.querySelectorAll("button");
    act(() => buttons[0].click());
    expect(container.textContent).toContain("synthetic-secret");
    act(() => buttons[1].click());
    expect(onCopySecret).toHaveBeenCalledWith("synthetic-secret");
    act(() => buttons[0].click());
    expect(container.textContent).not.toContain("synthetic-secret");
  });

  it("masks a changed value even when the previous value was revealed", () => {
    act(() => root.render(<SecretContent labels={labels} value="first-secret" />));
    act(() => container.querySelector("button")?.click());
    expect(container.textContent).toContain("first-secret");

    act(() => root.render(<SecretContent labels={labels} value="second-secret" />));
    expect(container.textContent).not.toContain("first-secret");
    expect(container.textContent).not.toContain("second-secret");
  });
});

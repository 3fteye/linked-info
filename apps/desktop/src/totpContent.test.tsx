// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTotpDirectiveLine } from "./totp";
import { TotpContentLine, type TotpContentLabels } from "./totpContent";

const labels: TotpContentLabels = {
  copy: "Copy code",
  generating: "Generating",
  invalid: "Invalid TOTP secret",
  masked: "Secret hidden",
  remaining: (seconds) => `${seconds}s`,
};

describe("TotpContentLine", () => {
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    container.remove();
  });

  it("renders and copies only the derived code", async () => {
    const directive = parseTotpDirectiveLine("TOTP: jbsw y3dp ehpk 3pxp");
    expect(directive).not.toBeNull();
    const onCopySecret = vi.fn();

    act(() => {
      root.render(
        <TotpContentLine
          directive={directive!}
          labels={labels}
          onCopySecret={onCopySecret}
        />,
      );
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });

    const output = container.querySelector(".totp-content-code");
    expect(output?.textContent).toMatch(/^\d{6}$/u);
    expect(container.textContent).not.toContain("jbsw");

    act(() => {
      container.querySelector<HTMLButtonElement>(".totp-content-copy")?.click();
    });
    expect(onCopySecret).toHaveBeenCalledOnce();
    expect(onCopySecret).toHaveBeenCalledWith(output?.textContent);
  });

  it("reports an invalid explicit directive without rendering its value", () => {
    const directive = parseTotpDirectiveLine("TOTP: malformed-secret");
    expect(directive).not.toBeNull();

    act(() =>
      root.render(<TotpContentLine directive={directive!} labels={labels} />),
    );

    expect(container.querySelector('[data-status="invalid"]')).not.toBeNull();
    expect(container.textContent).toContain(labels.invalid);
    expect(container.textContent).not.toContain("malformed-secret");
  });

  it("keeps the previous code and copy button in place while the next period loads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const directive = parseTotpDirectiveLine(
      "TOTP: otpauth://totp/Synthetic?secret=JBSWY3DPEHPK3PXP&period=1",
    );
    expect(directive).not.toBeNull();
    const onCopySecret = vi.fn();
    let signCallCount = 0;
    vi.spyOn(globalThis.crypto.subtle, "sign").mockImplementation(() => {
      signCallCount += 1;
      return signCallCount === 1
        ? Promise.resolve(new Uint8Array(20).buffer)
        : new Promise<ArrayBuffer>(() => undefined);
    });

    act(() => {
      root.render(
        <TotpContentLine
          directive={directive!}
          labels={labels}
          onCopySecret={onCopySecret}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const firstCode = container.querySelector(".totp-content-code")?.textContent;
    expect(firstCode).toMatch(/^\d{6}$/u);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });

    expect(signCallCount).toBe(2);
    expect(container.querySelector(".totp-content-code")?.textContent).toBe(firstCode);
    expect(container.querySelector(".totp-content-line")?.getAttribute("data-status")).toBe(
      "refreshing",
    );
    expect(
      container.querySelector<HTMLButtonElement>(".totp-content-copy")?.disabled,
    ).toBe(true);
  });
});

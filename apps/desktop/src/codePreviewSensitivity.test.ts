import { describe, expect, it, vi } from "vitest";
import { CodePreviewSensitivityCache } from "./codePreviewSensitivity";
import type { InformationNode } from "./workspaceData";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";

describe("CodePreviewSensitivityCache", () => {
  it("reclassifies only changed code nodes and retires inactive entries", () => {
    const first: InformationNode = { id: firstId, name: "First", content: "one" };
    const second: InformationNode = {
      id: secondId,
      name: "Second",
      content: "two",
    };
    const classify = vi.fn((content: string | null) => content === "secret");
    const cache = new CodePreviewSensitivityCache();
    const processors = {
      [firstId]: "code.typescript",
      [secondId]: "code.python",
    };

    expect(cache.update([first, second], processors, classify)).toEqual(
      new Map([
        [firstId, false],
        [secondId, false],
      ]),
    );
    expect(classify).toHaveBeenCalledTimes(2);

    const changedFirst = { ...first, content: "secret" };
    expect(cache.update([changedFirst, second], processors, classify)).toEqual(
      new Map([
        [firstId, true],
        [secondId, false],
      ]),
    );
    expect(classify).toHaveBeenCalledTimes(3);
    expect(classify).toHaveBeenLastCalledWith("secret");

    expect(
      cache.update([second], { [secondId]: "text" }, classify),
    ).toEqual(new Map());
    expect(classify).toHaveBeenCalledTimes(3);
  });
});

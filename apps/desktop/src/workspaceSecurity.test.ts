import { describe, expect, it } from "vitest";
import { isEncryptedWorkspaceExport } from "./workspaceSecurity";

describe("encrypted workspace export detection", () => {
  it("recognizes only the versioned encrypted export envelope", () => {
    expect(
      isEncryptedWorkspaceExport(
        JSON.stringify({
          format: "linked-info-encrypted-workspace-export",
          version: 1,
        }),
      ),
    ).toBe(true);
    expect(
      isEncryptedWorkspaceExport(
        JSON.stringify({ format: "linked-info-workspace", version: 1 }),
      ),
    ).toBe(false);
    expect(isEncryptedWorkspaceExport("not json")).toBe(false);
  });
});

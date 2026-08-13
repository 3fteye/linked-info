import { describe, expect, it } from "vitest";
import contract from "../../../fixtures/workspace-contract.json";
import {
  currentWorkspaceStorageVersion,
  parseStoredWorkspaceText,
  serializeStoredWorkspace,
} from "./workspaceStore";

describe("shared workspace contract", () => {
  for (const fixture of contract.cases) {
    it(fixture.name, () => {
      const parsed = parseStoredWorkspaceText(JSON.stringify(fixture.storage));
      expect(parsed.status === "ready").toBe(fixture.valid);
      if (parsed.status === "ready") {
        const normalized = JSON.parse(
          serializeStoredWorkspace(parsed.workspace),
        ) as { version: number };
        expect(normalized.version).toBe(currentWorkspaceStorageVersion);
      }
    });
  }
});

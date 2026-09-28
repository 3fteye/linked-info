import { describe, expect, it } from "vitest";
import { canvasOperationIds, featureOperationIds } from "./canvasOperations";
import { featureDemoLocales } from "./featureDemoLocales";
import { resources } from "./locales";

describe("operation demo coverage", () => {
  it("keeps one shared, unique catalog with bilingual labels and complete steps", () => {
    expect(new Set(canvasOperationIds).size).toBe(canvasOperationIds.length);
    for (const language of ["zh-CN", "en-US"] as const) {
      for (const id of canvasOperationIds) {
        const item = resources[language].translation.canvasShortcuts.items[id];
        expect(item.action.length).toBeGreaterThan(0);
        expect(item.keys.length).toBeGreaterThan(0);
      }
      expect(Object.keys(featureDemoLocales[language]).sort()).toEqual([...featureOperationIds].sort());
      for (const id of featureOperationIds) {
        expect(Object.keys(featureDemoLocales[language][id])).toHaveLength(4);
        for (const step of Object.values(featureDemoLocales[language][id])) {
          for (const text of Object.values(step)) expect(text.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });
});

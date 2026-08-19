import { describe, expect, it } from "vitest";
import {
  canvasAutoAvoidOverlapsPreferenceKey,
  loadCanvasAutoAvoidOverlaps,
  saveCanvasAutoAvoidOverlaps,
} from "./canvasPreferences";

describe("canvas preferences", () => {
  it("defaults automatic overlap avoidance to enabled", () => {
    expect(loadCanvasAutoAvoidOverlaps(null)).toBe(true);
    expect(
      loadCanvasAutoAvoidOverlaps({
        getItem: () => null,
        setItem: () => undefined,
      }),
    ).toBe(true);
  });

  it("persists and restores an explicit disabled preference", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    saveCanvasAutoAvoidOverlaps(storage, false);

    expect(values.get(canvasAutoAvoidOverlapsPreferenceKey)).toBe("false");
    expect(loadCanvasAutoAvoidOverlaps(storage)).toBe(false);
  });
});

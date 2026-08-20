import { describe, expect, it } from "vitest";
import {
  appearanceThemePreferenceKey,
  loadAppearanceTheme,
  saveAppearanceTheme,
} from "./appearancePreferences";

describe("appearance preferences", () => {
  it("defaults to the low-glare starry theme", () => {
    expect(loadAppearanceTheme(null)).toBe("starry-dark");
    expect(
      loadAppearanceTheme({
        getItem: () => null,
        setItem: () => undefined,
      }),
    ).toBe("starry-dark");
  });

  it("persists and restores a supported theme", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    saveAppearanceTheme(storage, "mint-light");

    expect(values.get(appearanceThemePreferenceKey)).toBe("mint-light");
    expect(loadAppearanceTheme(storage)).toBe("mint-light");
  });

  it("rejects unknown stored values", () => {
    expect(
      loadAppearanceTheme({
        getItem: () => "future-theme",
        setItem: () => undefined,
      }),
    ).toBe("starry-dark");
  });
});

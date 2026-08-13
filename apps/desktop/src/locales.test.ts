import { describe, expect, it } from "vitest";
import { resources } from "./locales";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, nested]) =>
    leafKeys(nested, prefix.length === 0 ? key : `${prefix}.${key}`),
  );
}

describe("locale resources", () => {
  it("keeps Simplified Chinese and English translation keys identical", () => {
    const chinese = leafKeys(resources["zh-CN"].translation).sort();
    const english = leafKeys(resources["en-US"].translation).sort();

    expect(english).toEqual(chinese);
  });
});

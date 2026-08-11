import { describe, expect, it } from "vitest";
import {
  defaultEmbeddingSettings,
  embeddingSettingsFingerprint,
  parseEmbeddingSettings,
  updateEmbeddingSettings,
} from "./embeddingSettings";

describe("embedding settings", () => {
  it("uses safe defaults for malformed persisted values", () => {
    expect(parseEmbeddingSettings({
      provider: "unknown",
      autoReferenceEnabled: "yes",
      autoReferenceThreshold: 4,
    })).toEqual(defaultEmbeddingSettings);
  });

  it("disables automatic references when the provider fingerprint changes", () => {
    const current = updateEmbeddingSettings(defaultEmbeddingSettings, {
      autoReferenceEnabled: true,
      autoReferenceThreshold: 0.9,
    });
    const changed = updateEmbeddingSettings(current, { provider: "remote" });

    expect(changed.autoReferenceEnabled).toBe(false);
    expect(changed.thresholdFingerprint).toBeNull();
    expect(embeddingSettingsFingerprint(changed)).toContain('"remote"');
  });
});

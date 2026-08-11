import { describe, expect, it } from "vitest";
import {
  defaultEmbeddingSettings,
  embeddingSettingsFingerprint,
  parseEmbeddingSettings,
  smartReferenceScoringFingerprint,
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

  it("preserves a supported saved local model and rejects unknown models", () => {
    expect(
      parseEmbeddingSettings({ localModel: "intfloat/multilingual-e5-small" })
        .localModel,
    ).toBe("intfloat/multilingual-e5-small");
    expect(parseEmbeddingSettings({ localModel: "unknown/model" }).localModel).toBe(
      defaultEmbeddingSettings.localModel,
    );
  });

  it("includes the pinned local model revision in its fingerprint", () => {
    expect(embeddingSettingsFingerprint(defaultEmbeddingSettings)).toContain(
      "75c43b069aac4d136ba6bc1122f995fedcfd2781",
    );
  });

  it("invalidates a threshold saved by the previous recommendation algorithm", () => {
    const parsed = parseEmbeddingSettings({
      ...defaultEmbeddingSettings,
      autoReferenceEnabled: true,
      autoReferenceThreshold: 0.86,
      thresholdFingerprint: embeddingSettingsFingerprint(defaultEmbeddingSettings),
    });

    expect(parsed.autoReferenceEnabled).toBe(false);
    expect(parsed.autoReferenceThreshold).toBe(0.6);
    expect(parsed.thresholdFingerprint).toBeNull();
  });

  it("disables automation when its threshold has no scoring fingerprint", () => {
    const parsed = parseEmbeddingSettings({
      ...defaultEmbeddingSettings,
      autoReferenceEnabled: true,
      autoReferenceThreshold: 0.75,
      thresholdFingerprint: null,
    });

    expect(parsed.autoReferenceEnabled).toBe(false);
    expect(parsed.autoReferenceThreshold).toBe(0.6);
  });

  it("keeps a threshold calibrated for graph reference propagation", () => {
    const calibrated = updateEmbeddingSettings(defaultEmbeddingSettings, {
      autoReferenceEnabled: true,
      autoReferenceThreshold: 0.7,
    });

    expect(calibrated.thresholdFingerprint).toBe(
      smartReferenceScoringFingerprint(calibrated),
    );
    expect(parseEmbeddingSettings(calibrated)).toEqual(calibrated);
  });
});

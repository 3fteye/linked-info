import { describe, expect, it } from "vitest";
import {
  defaultLlmSettings,
  parseLlmSettings,
  updateLlmSettings,
} from "./llmSettings";

describe("LLM settings", () => {
  it("uses local disabled defaults for missing or invalid settings", () => {
    expect(parseLlmSettings(null)).toEqual(defaultLlmSettings);
    expect(parseLlmSettings({ enabled: "yes", localModel: "unknown" })).toEqual(
      defaultLlmSettings,
    );
  });

  it("keeps the supported model and explicit enabled state", () => {
    expect(
      parseLlmSettings({
        enabled: true,
        localModel: "Qwen/Qwen3-1.7B-GGUF",
      }),
    ).toEqual({
      enabled: true,
      localModel: "Qwen/Qwen3-1.7B-GGUF",
    });
  });

  it("updates through the same boundary validation", () => {
    expect(updateLlmSettings(defaultLlmSettings, { enabled: true })).toEqual({
      ...defaultLlmSettings,
      enabled: true,
    });
  });
});

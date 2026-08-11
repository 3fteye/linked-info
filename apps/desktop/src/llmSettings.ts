import {
  isLocalLlmModelId,
  type LocalLlmModelId,
} from "./localLlmModels";

export interface LlmSettings {
  enabled: boolean;
  localModel: LocalLlmModelId;
}

export interface LlmSettingsStore {
  load(): LlmSettings;
  save(settings: LlmSettings): void;
}

export const defaultLlmSettings: LlmSettings = {
  enabled: false,
  localModel: "Qwen/Qwen3-1.7B-GGUF",
};

const llmSettingsStorageKey = "linked-info.llm-settings.v1";

export function parseLlmSettings(value: unknown): LlmSettings {
  if (typeof value !== "object" || value === null) {
    return { ...defaultLlmSettings };
  }
  const candidate = value as Partial<LlmSettings>;
  return {
    enabled: candidate.enabled === true,
    localModel: isLocalLlmModelId(candidate.localModel)
      ? candidate.localModel
      : defaultLlmSettings.localModel,
  };
}

export function updateLlmSettings(
  current: LlmSettings,
  patch: Partial<LlmSettings>,
): LlmSettings {
  return parseLlmSettings({ ...current, ...patch });
}

export const localLlmSettingsStore: LlmSettingsStore = {
  load() {
    try {
      const raw = localStorage.getItem(llmSettingsStorageKey);
      return raw === null
        ? { ...defaultLlmSettings }
        : parseLlmSettings(JSON.parse(raw) as unknown);
    } catch {
      return { ...defaultLlmSettings };
    }
  },
  save(settings) {
    localStorage.setItem(llmSettingsStorageKey, JSON.stringify(settings));
  },
};

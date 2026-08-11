import {
  isLocalEmbeddingModelId,
  localEmbeddingModelDefinition,
  type LocalEmbeddingModelId,
} from "./localEmbeddingModels";

export type EmbeddingProviderMode = "local" | "remote";

export interface EmbeddingSettings {
  provider: EmbeddingProviderMode;
  localModel: LocalEmbeddingModelId;
  remoteEndpoint: string;
  remoteModel: string;
  autoReferenceEnabled: boolean;
  autoReferenceThreshold: number;
  thresholdFingerprint: string | null;
}

export interface EmbeddingSettingsStore {
  load(): EmbeddingSettings;
  save(settings: EmbeddingSettings): void;
}

export const defaultEmbeddingSettings: EmbeddingSettings = {
  provider: "local",
  localModel: "BAAI/bge-small-zh-v1.5",
  remoteEndpoint: "",
  remoteModel: "",
  autoReferenceEnabled: false,
  autoReferenceThreshold: 0.86,
  thresholdFingerprint: null,
};

const embeddingSettingsStorageKey = "linked-info.embedding-settings.v1";

function validThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function embeddingSettingsFingerprint(settings: EmbeddingSettings): string {
  if (settings.provider === "local") {
    const model = localEmbeddingModelDefinition(settings.localModel);
    return JSON.stringify([
      "local",
      model.id,
      model.repository,
      model.revision,
      "embedding-input-v1",
    ]);
  }
  return JSON.stringify([
    "remote",
    settings.remoteEndpoint.trim(),
    settings.remoteModel.trim(),
    "embedding-input-v1",
  ]);
}

export function parseEmbeddingSettings(value: unknown): EmbeddingSettings {
  if (typeof value !== "object" || value === null) {
    return { ...defaultEmbeddingSettings };
  }

  const candidate = value as Partial<EmbeddingSettings>;
  const provider = candidate.provider === "remote" ? "remote" : "local";
  return {
    provider,
    localModel: isLocalEmbeddingModelId(candidate.localModel)
      ? candidate.localModel
      : defaultEmbeddingSettings.localModel,
    remoteEndpoint:
      typeof candidate.remoteEndpoint === "string"
        ? candidate.remoteEndpoint.slice(0, 2048)
        : "",
    remoteModel:
      typeof candidate.remoteModel === "string" ? candidate.remoteModel.slice(0, 256) : "",
    autoReferenceEnabled: candidate.autoReferenceEnabled === true,
    autoReferenceThreshold: validThreshold(candidate.autoReferenceThreshold)
      ? candidate.autoReferenceThreshold
      : defaultEmbeddingSettings.autoReferenceThreshold,
    thresholdFingerprint:
      typeof candidate.thresholdFingerprint === "string"
        ? candidate.thresholdFingerprint.slice(0, 2560)
        : null,
  };
}

export function updateEmbeddingSettings(
  current: EmbeddingSettings,
  patch: Partial<EmbeddingSettings>,
): EmbeddingSettings {
  const next = parseEmbeddingSettings({ ...current, ...patch });
  const providerChanged =
    embeddingSettingsFingerprint(current) !== embeddingSettingsFingerprint(next);

  if (providerChanged) {
    return {
      ...next,
      autoReferenceEnabled: false,
      thresholdFingerprint: null,
    };
  }

  if (patch.autoReferenceThreshold !== undefined) {
    next.thresholdFingerprint = embeddingSettingsFingerprint(next);
  }
  if (next.autoReferenceEnabled && next.thresholdFingerprint === null) {
    next.thresholdFingerprint = embeddingSettingsFingerprint(next);
  }
  return next;
}

export const localEmbeddingSettingsStore: EmbeddingSettingsStore = {
  load() {
    try {
      const raw = localStorage.getItem(embeddingSettingsStorageKey);
      if (raw === null) {
        return { ...defaultEmbeddingSettings };
      }
      return parseEmbeddingSettings(JSON.parse(raw) as unknown);
    } catch {
      return { ...defaultEmbeddingSettings };
    }
  },
  save(settings) {
    localStorage.setItem(embeddingSettingsStorageKey, JSON.stringify(settings));
  },
};

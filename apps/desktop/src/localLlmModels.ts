export const localLlmModelIds = [
  "Qwen/Qwen3-1.7B-GGUF",
  "Qwen/Qwen3-4B-GGUF",
] as const;

export type LocalLlmModelId = (typeof localLlmModelIds)[number];

export interface LocalLlmModelDefinition {
  id: LocalLlmModelId;
  contextTokens: number;
  downloadBytes: number;
  fileName: string;
  license: "Apache-2.0";
  quantization: "Q8_0";
  repository: string;
  revision: string;
  runtime: string;
  translationKey: "qwen3_1_7B" | "qwen3_4B";
}

export type LocalLlmPhase =
  | "checking"
  | "downloading"
  | "retrying"
  | "verifying"
  | "loading"
  | "inferencing"
  | "ready"
  | "cancelled"
  | "failed";

export interface LocalLlmProgress {
  modelId: LocalLlmModelId;
  phase: LocalLlmPhase;
  fileName: string | null;
  downloadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
}

export interface LocalLlmModelStatus {
  modelId: LocalLlmModelId;
  cachedBytes: number;
  totalBytes: number;
  ready: boolean;
  verificationRequired: boolean;
  loaded: boolean;
  runtimeAvailable: boolean;
}

export interface LocalLlmRuntime {
  cancelDownload(): Promise<void>;
  inspectModels(): Promise<LocalLlmModelStatus[]>;
  prepareModel(modelId: LocalLlmModelId): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (progress: LocalLlmProgress) => void): Promise<() => void>;
}

export const localLlmModels: readonly LocalLlmModelDefinition[] = [
  {
    id: "Qwen/Qwen3-1.7B-GGUF",
    contextTokens: 4_096,
    downloadBytes: 1_834_426_016,
    fileName: "Qwen3-1.7B-Q8_0.gguf",
    license: "Apache-2.0",
    quantization: "Q8_0",
    repository: "Qwen/Qwen3-1.7B-GGUF",
    revision: "90862c4b9d2787eaed51d12237eafdfe7c5f6077",
    runtime: "llama.cpp b10344 CPU",
    translationKey: "qwen3_1_7B",
  },
  {
    id: "Qwen/Qwen3-4B-GGUF",
    contextTokens: 4_096,
    downloadBytes: 4_280_404_704,
    fileName: "Qwen3-4B-Q8_0.gguf",
    license: "Apache-2.0",
    quantization: "Q8_0",
    repository: "Qwen/Qwen3-4B-GGUF",
    revision: "bc640142c66e1fdd12af0bd68f40445458f3869b",
    runtime: "llama.cpp b10344 CPU",
    translationKey: "qwen3_4B",
  },
];

export function isLocalLlmModelId(value: unknown): value is LocalLlmModelId {
  return (
    typeof value === "string" &&
    (localLlmModelIds as readonly string[]).includes(value)
  );
}

export function localLlmModelDefinition(
  id: LocalLlmModelId,
): LocalLlmModelDefinition {
  const definition = localLlmModels.find((model) => model.id === id);
  if (definition === undefined) {
    throw new Error(`unsupported local LLM model: ${id}`);
  }
  return definition;
}

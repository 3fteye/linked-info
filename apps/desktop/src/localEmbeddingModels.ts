export const localEmbeddingModelIds = [
  "BAAI/bge-small-zh-v1.5",
  "sentence-transformers/all-MiniLM-L6-v2",
  "intfloat/multilingual-e5-small",
] as const;

export type LocalEmbeddingModelId = (typeof localEmbeddingModelIds)[number];

export interface LocalEmbeddingModelDefinition {
  id: LocalEmbeddingModelId;
  downloadBytes: number;
  dimensions: number;
  license: "MIT" | "Apache-2.0";
  repository: string;
  revision: string;
  translationKey: "bgeSmallZh" | "miniLmL6" | "multilingualE5Small";
}

export type LocalEmbeddingPhase =
  | "checking"
  | "downloading"
  | "verifying"
  | "loading"
  | "inferencing"
  | "ready"
  | "cancelled"
  | "failed";

export interface LocalEmbeddingProgress {
  modelId: LocalEmbeddingModelId;
  phase: LocalEmbeddingPhase;
  fileName: string | null;
  fileIndex: number;
  fileCount: number;
  fileDownloadedBytes: number;
  fileTotalBytes: number;
  downloadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
}

export interface LocalEmbeddingModelStatus {
  modelId: LocalEmbeddingModelId;
  cachedBytes: number;
  totalBytes: number;
  ready: boolean;
}

export interface LocalEmbeddingRuntime {
  cancelDownload(): Promise<void>;
  inspectModels(): Promise<LocalEmbeddingModelStatus[]>;
  prepareModel(modelId: LocalEmbeddingModelId): Promise<void>;
  subscribe(
    listener: (progress: LocalEmbeddingProgress) => void,
  ): Promise<() => void>;
}

export const localEmbeddingModels: readonly LocalEmbeddingModelDefinition[] = [
  {
    id: "BAAI/bge-small-zh-v1.5",
    downloadBytes: 95_292_210,
    dimensions: 512,
    license: "MIT",
    repository: "Xenova/bge-small-zh-v1.5",
    revision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
    translationKey: "bgeSmallZh",
  },
  {
    id: "sentence-transformers/all-MiniLM-L6-v2",
    downloadBytes: 23_685_172,
    dimensions: 384,
    license: "Apache-2.0",
    repository: "Xenova/all-MiniLM-L6-v2",
    revision: "751bff37182d3f1213fa05d7196b954e230abad9",
    translationKey: "miniLmL6",
  },
  {
    id: "intfloat/multilingual-e5-small",
    downloadBytes: 487_352_505,
    dimensions: 384,
    license: "MIT",
    repository: "intfloat/multilingual-e5-small",
    revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
    translationKey: "multilingualE5Small",
  },
];

export function isLocalEmbeddingModelId(value: unknown): value is LocalEmbeddingModelId {
  return (
    typeof value === "string" &&
    (localEmbeddingModelIds as readonly string[]).includes(value)
  );
}

export function localEmbeddingModelDefinition(
  id: LocalEmbeddingModelId,
): LocalEmbeddingModelDefinition {
  const definition = localEmbeddingModels.find((model) => model.id === id);
  if (definition === undefined) {
    throw new Error(`unsupported local embedding model: ${id}`);
  }
  return definition;
}

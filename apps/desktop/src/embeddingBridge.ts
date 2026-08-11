import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  EmbeddingGateway,
  EmbeddingInput,
  RemoteEmbeddingConfiguration,
} from "./embeddingService";
import type {
  EmbeddingVectorCache,
  EmbeddingVectorCacheStatus,
} from "./embeddingCache";
import type {
  LocalEmbeddingModelId,
  LocalEmbeddingModelStatus,
  LocalEmbeddingProgress,
  LocalEmbeddingRuntime,
} from "./localEmbeddingModels";

const localEmbeddingProgressEvent = "linked-info://local-embedding-progress";

export const tauriEmbeddingGateway: EmbeddingGateway = {
  embedLocal(modelId, inputs) {
    return invoke<number[][]>("embed_local_texts", { modelId, inputs });
  },
  embedRemote(configuration, inputs) {
    return invoke<number[][]>("embed_remote_texts", {
      request: {
        endpoint: configuration.endpoint,
        model: configuration.model,
        token: configuration.token || null,
        inputs: inputs.map((input) => input.text),
      },
    });
  },
};

export const tauriEmbeddingVectorCache: EmbeddingVectorCache = {
  read(keys) {
    return invoke<Array<number[] | null>>("read_embedding_vector_cache", { keys });
  },
  write(entries) {
    return invoke<void>("write_embedding_vector_cache", { entries });
  },
  inspect() {
    return invoke<EmbeddingVectorCacheStatus>("inspect_embedding_vector_cache");
  },
  clear() {
    return invoke<EmbeddingVectorCacheStatus>("clear_embedding_vector_cache");
  },
};

export const tauriLocalEmbeddingRuntime: LocalEmbeddingRuntime = {
  cancelDownload() {
    return invoke<void>("cancel_local_embedding_download");
  },
  inspectModels() {
    return invoke<LocalEmbeddingModelStatus[]>("inspect_local_embedding_models");
  },
  prepareModel(modelId) {
    return invoke<void>("prepare_local_embedding_model", { modelId });
  },
  async subscribe(listener) {
    return listen<LocalEmbeddingProgress>(localEmbeddingProgressEvent, (event) => {
      listener(event.payload);
    });
  },
};

function unavailable(): Promise<number[][]> {
  return Promise.reject(new Error("embedding is only available in the desktop runtime"));
}

export const unavailableEmbeddingGateway: EmbeddingGateway = {
  embedLocal: unavailable,
  embedRemote(
    _configuration: RemoteEmbeddingConfiguration,
    _inputs: EmbeddingInput[],
  ) {
    return unavailable();
  },
};

export const unavailableLocalEmbeddingRuntime: LocalEmbeddingRuntime = {
  cancelDownload() {
    return Promise.resolve();
  },
  inspectModels() {
    return Promise.resolve([]);
  },
  prepareModel(_modelId: LocalEmbeddingModelId) {
    return Promise.reject(
      new Error("local embedding models are only available in the desktop runtime"),
    );
  },
  subscribe(_listener) {
    return Promise.resolve(() => undefined);
  },
};

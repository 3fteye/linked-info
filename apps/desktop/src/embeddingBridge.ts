import { invoke } from "@tauri-apps/api/core";
import type {
  EmbeddingGateway,
  EmbeddingInput,
  RemoteEmbeddingConfiguration,
} from "./embeddingService";

export const tauriEmbeddingGateway: EmbeddingGateway = {
  embedLocal(inputs) {
    return invoke<number[][]>("embed_local_texts", { inputs });
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

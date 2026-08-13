import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { LlmGateway } from "./llmReview";
import type {
  LocalLlmModelId,
  LocalLlmModelStatus,
  LocalLlmProgress,
  LocalLlmRuntime,
} from "./localLlmModels";
import type {
  DocumentImportChunkRequest,
  DocumentImportChunkResponse,
  DocumentImportLlmGateway,
} from "./documentImport";

const localLlmProgressEvent = "linked-info://local-llm-progress";

export const tauriLlmGateway: LlmGateway = {
  review(configuration, request) {
    if (configuration.kind !== "local") {
      return Promise.reject(new Error("unsupported LLM provider"));
    }
    return invoke("review_local_references", {
      modelId: configuration.modelId,
      request,
    });
  },
};

export const tauriDocumentImportLlmGateway: DocumentImportLlmGateway = {
  extractChunk(modelId, request) {
    return invoke<DocumentImportChunkResponse>("extract_local_document_import", {
      modelId,
      request,
    });
  },
};

export const tauriLocalLlmRuntime: LocalLlmRuntime = {
  cancelDownload() {
    return invoke<void>("cancel_local_llm_download");
  },
  inspectModels() {
    return invoke<LocalLlmModelStatus[]>("inspect_local_llm_models");
  },
  prepareModel(modelId) {
    return invoke<void>("prepare_local_llm_model", { modelId });
  },
  stop() {
    return invoke<void>("stop_local_llm");
  },
  async subscribe(listener) {
    return listen<LocalLlmProgress>(localLlmProgressEvent, (event) => {
      listener(event.payload);
    });
  },
};

export const unavailableLlmGateway: LlmGateway = {
  review() {
    return Promise.reject(new Error("LLM review is only available in the desktop runtime"));
  },
};

export const unavailableDocumentImportLlmGateway: DocumentImportLlmGateway = {
  extractChunk(_modelId, _request: DocumentImportChunkRequest) {
    return Promise.reject(new Error("document import requires the desktop runtime"));
  },
};

export const unavailableLocalLlmRuntime: LocalLlmRuntime = {
  cancelDownload() {
    return Promise.resolve();
  },
  inspectModels() {
    return Promise.resolve([]);
  },
  prepareModel(_modelId: LocalLlmModelId) {
    return Promise.reject(
      new Error("local LLM models are only available in the desktop runtime"),
    );
  },
  stop() {
    return Promise.resolve();
  },
  subscribe() {
    return Promise.resolve(() => undefined);
  },
};

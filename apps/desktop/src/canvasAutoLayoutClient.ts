import type {
  SmartArrangementResult,
} from "./canvasAutoLayout";
import type {
  SmartArrangementWorkerRequest,
  SmartArrangementWorkerResponse,
} from "./canvasAutoLayout.worker";

export function arrangeCanvasNodesInWorker(
  request: SmartArrangementWorkerRequest,
  signal?: AbortSignal,
): Promise<SmartArrangementResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Canvas arrangement was cancelled", "AbortError"));
      return;
    }
    const worker = new Worker(
      new URL("./canvasAutoLayout.worker.ts", import.meta.url),
      { type: "module" },
    );
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      finish();
      reject(new DOMException("Canvas arrangement was cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = () => {
      finish();
      reject(new Error("Canvas arrangement worker failed"));
    };
    worker.onmessage = (event: MessageEvent<SmartArrangementWorkerResponse>) => {
      finish();
      if (!event.data.ok) {
        reject(new Error("Canvas arrangement failed"));
        return;
      }
      resolve(event.data.result);
    };
    worker.postMessage(request);
  });
}

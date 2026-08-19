import {
  arrangeCanvasNodes,
  type SmartArrangementMode,
  type SmartArrangementReference,
  type SmartArrangementResult,
  type SmartArrangementSizeMode,
} from "./canvasAutoLayout";
import type { CanvasRectangle } from "./canvasOverlap";

export interface SmartArrangementWorkerRequest {
  mode: SmartArrangementMode;
  nodes: CanvasRectangle[];
  references: SmartArrangementReference[];
  sizeMode: SmartArrangementSizeMode;
}

export type SmartArrangementWorkerResponse =
  | { ok: true; result: SmartArrangementResult }
  | { ok: false };

self.onmessage = (event: MessageEvent<SmartArrangementWorkerRequest>) => {
  try {
    const request = event.data;
    const result = arrangeCanvasNodes(
      request.nodes,
      request.references,
      request.mode,
      request.sizeMode,
    );
    self.postMessage({ ok: true, result } satisfies SmartArrangementWorkerResponse);
  } catch {
    self.postMessage({ ok: false } satisfies SmartArrangementWorkerResponse);
  }
};

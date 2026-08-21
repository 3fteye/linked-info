export const canvasOperationIds = [
  "pan",
  "zoom",
  "frame",
  "select",
  "selectAll",
  "edit",
  "resize",
  "arrange",
  "search",
  "transfer",
  "history",
  "contextMenu",
  "cancel",
  "help",
] as const;

export type CanvasOperationId = (typeof canvasOperationIds)[number];

export interface CanvasOperationItem {
  action: string;
  id: CanvasOperationId;
  keys: string;
}

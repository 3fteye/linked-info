export const featureOperationIds = [
  "templates", "browse", "bookmarks", "references", "incoming", "markers", "smartQueue", "filterContext",
] as const;
export type FeatureOperationId = (typeof featureOperationIds)[number];

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
  ...featureOperationIds,
] as const;

export type CanvasOperationId = (typeof canvasOperationIds)[number];

export interface CanvasOperationItem {
  action: string;
  id: CanvasOperationId;
  keys: string;
}

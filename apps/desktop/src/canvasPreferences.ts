export const canvasAutoAvoidOverlapsPreferenceKey =
  "linked-info.canvas.auto-avoid-overlaps.v1";

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadCanvasAutoAvoidOverlaps(
  storage: PreferenceStorage | null,
): boolean {
  if (storage === null) {
    return true;
  }
  try {
    return storage.getItem(canvasAutoAvoidOverlapsPreferenceKey) !== "false";
  } catch {
    return true;
  }
}

export function saveCanvasAutoAvoidOverlaps(
  storage: PreferenceStorage | null,
  enabled: boolean,
): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(canvasAutoAvoidOverlapsPreferenceKey, String(enabled));
  } catch {
    // The preference is optional; a blocked local store must not break the canvas.
  }
}

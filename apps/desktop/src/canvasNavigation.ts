import type { CanvasViewport } from "./workspaceData";
import type { NodeSearchScope } from "./nodeSearch";

export interface CanvasNavigationLocation {
  canvasId: string;
  viewport: CanvasViewport | null;
  nodeId: string | null;
  searchTerm: string;
  searchScope: NodeSearchScope;
  searchLocationScope: "canvas" | "workspace";
  unnamedOnly: boolean;
  referenceFilterNodeIds: string[];
}
export interface CanvasNavigationHistory {
  back: CanvasNavigationLocation[];
  forward: CanvasNavigationLocation[];
}
export const emptyCanvasNavigation = (): CanvasNavigationHistory => ({ back: [], forward: [] });
export function rememberCanvasLocation(history: CanvasNavigationHistory, location: CanvasNavigationLocation): CanvasNavigationHistory {
  const last = history.back.at(-1);
  return {
    back: (last !== undefined && JSON.stringify(last) === JSON.stringify(location)
      ? history.back : [...history.back, location]).slice(-100),
    forward: [],
  };
}
export function traverseCanvasLocations(
  history: CanvasNavigationHistory, direction: "back" | "forward",
  current: CanvasNavigationLocation, existingCanvasIds: ReadonlySet<string>,
): { history: CanvasNavigationHistory; location: CanvasNavigationLocation | null } {
  const candidates = [...history[direction]];
  let location: CanvasNavigationLocation | undefined;
  while ((location = candidates.pop()) !== undefined) {
    if (existingCanvasIds.has(location.canvasId)) break;
  }
  const opposite = direction === "back" ? "forward" : "back";
  return {
    history: { ...history, [direction]: candidates,
      [opposite]: location === undefined ? history[opposite] : [...history[opposite], current].slice(-100) },
    location: location ?? null,
  };
}

import { describe, expect, it } from "vitest";
import { emptyCanvasNavigation, rememberCanvasLocation, traverseCanvasLocations, type CanvasNavigationLocation } from "./canvasNavigation";
function location(canvasId: string): CanvasNavigationLocation {
  return { canvasId, viewport: { x: 10, y: 20, zoom: 1 }, nodeId: null, searchTerm: "synthetic", searchScope: "both", searchLocationScope: "canvas", unnamedOnly: false, referenceFilterNodeIds: [] };
}
describe("canvas navigation", () => {
  it("returns to exact viewport and filters and can go forward without adding another jump", () => {
    const history = rememberCanvasLocation(emptyCanvasNavigation(), location("A"));
    const back = traverseCanvasLocations(history, "back", location("B"), new Set(["A", "B"]));
    expect(back.location).toEqual(location("A"));
    const forward = traverseCanvasLocations(back.history, "forward", location("A"), new Set(["A", "B"]));
    expect(forward.location).toEqual(location("B"));
    expect(forward.history).toEqual(history);
  });
  it("skips deleted canvases without recreating anything", () => {
    let history = rememberCanvasLocation(emptyCanvasNavigation(), location("A"));
    history = rememberCanvasLocation(history, location("deleted"));
    const step = traverseCanvasLocations(history, "back", location("B"), new Set(["A", "B"]));
    expect(step.location?.canvasId).toBe("A");
    expect(step.history.back).toEqual([]);
  });
  it("drops the forward branch on a new navigation and bounds memory", () => {
    let history = emptyCanvasNavigation();
    for (let index = 0; index < 150; index++) history = rememberCanvasLocation(history, location(String(index)));
    expect(history.back).toHaveLength(100);
    expect(history.back[0].canvasId).toBe("50");
    const stepped = traverseCanvasLocations(history, "back", location("current"), new Set(["149"]));
    expect(rememberCanvasLocation(stepped.history, location("other")).forward).toEqual([]);
  });
  it("deduplicates consecutive positions and empties an entirely invalid direction", () => {
    let history = rememberCanvasLocation(emptyCanvasNavigation(), location("A"));
    history = rememberCanvasLocation(history, location("A"));
    expect(history.back).toHaveLength(1);
    expect(traverseCanvasLocations(history, "back", location("B"), new Set()).location).toBeNull();
    expect(emptyCanvasNavigation()).toEqual({ back: [], forward: [] });
  });
});

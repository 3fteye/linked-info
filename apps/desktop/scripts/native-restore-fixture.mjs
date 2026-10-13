// Synthetic fixtures only. The caller must enforce the hosted-runner gate.
export function restoreFixture(restored) {
  const ids = restored
    ? ["00000000-0000-4000-8000-000000001201", "00000000-0000-4000-8000-000000001202"]
    : ["00000000-0000-4000-8000-000000001101", "00000000-0000-4000-8000-000000001102"];
  const name = restored ? "Synthetic restored" : "Synthetic original";
  return {
    version: 6,
    nodes: ids.map((id, index) => ({ id, name: `${name} ${index}`, content: `${name} body ${index}` })),
    references: [{ sourceNodeId: ids[0], targetNodeId: ids[1] }],
    view: {
      activeCanvasId: "00000000-0000-4000-8000-000000000001",
      canvases: [{
        id: "00000000-0000-4000-8000-000000000001", name: "Main",
        layout: ids.map((nodeId, index) => ({ nodeId, x: 100 + index * 350,
          y: restored ? 280 : 80, width: 320, height: 200 })),
        viewport: { x: 0, y: 0, zoom: 1 },
      }],
      contentProcessorByNodeId: {},
      extensionMetadata: { "dev.example.native-restore": {
        schemaVersion: 1, workspace: { fixture: name }, byNodeId: { [ids[0]]: { retained: true } },
      } },
      bookmarks: [], timeline: null,
    },
  };
}

// Playwright serializes this function into the owned main WebView. No actual
// document leaves that page: only the two comparison booleans are returned.
export async function inspectRestoredSlots({ ownerId, expectedPrimary, expectedRecovery }) {
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  }
  async function matches(slot, expected) {
    const text = await window.__TAURI_INTERNALS__.invoke("read_workspace_file", { ownerId, slot });
    if (text === null) return false;
    return JSON.stringify(canonical(JSON.parse(text))) === JSON.stringify(canonical(expected));
  }
  return {
    primaryMatches: await matches("primary", expectedPrimary),
    recoveryMatches: await matches("recovery", expectedRecovery),
  };
}

import { expect, test, type Page } from "@playwright/test";

interface SyntheticNode {
  id: string;
  name: string;
  x: number;
  y: number;
}

const workspaceStorageKey = "linked-info.workspace.v1";

function syntheticId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function gridNodes(columns: number, rows: number): SyntheticNode[] {
  return Array.from({ length: columns * rows }, (_, index) => ({
    id: syntheticId(index + 1),
    name: `Synthetic ${index + 1}`,
    x: 100 + (index % columns) * 360,
    y: 100 + Math.floor(index / columns) * 180,
  }));
}

async function openSyntheticWorkspace(page: Page, nodes: SyntheticNode[]) {
  await page.addInitScript(
    ({ storageKey, syntheticNodes }) => {
      const seedMarker = `${storageKey}.playwright-seeded`;
      if (sessionStorage.getItem(seedMarker) === "true") {
        return;
      }
      localStorage.clear();
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 2,
          nodes: syntheticNodes.map((node) => ({
            id: node.id,
            name: node.name,
            content: `Generated test content for ${node.name}`,
          })),
          layout: syntheticNodes.map((node) => ({
            nodeId: node.id,
            x: node.x,
            y: node.y,
          })),
          references: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          view: { contentProcessorByNodeId: {} },
        }),
      );
      sessionStorage.setItem(seedMarker, "true");
    },
    { storageKey: workspaceStorageKey, syntheticNodes: nodes },
  );
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
}

function node(page: Page, id: string) {
  return page.locator(`[data-node-id="${id}"]`);
}

async function storedWorkspace(page: Page) {
  return page.evaluate((storageKey) => {
    const raw = localStorage.getItem(storageKey);
    return raw === null ? null : JSON.parse(raw);
  }, workspaceStorageKey);
}

test("creating and editing a node survives a browser reload", async ({ page }) => {
  await openSyntheticWorkspace(page, gridNodes(1, 1));
  const syntheticContent = [
    "# Persisted synthetic heading",
    "",
    "**Formatted content**",
    "",
    "TOTP: jbsw y3dp ehpk 3pxp",
    "",
    "<script>blocked</script>",
  ].join("\n");

  await page.getByTestId("create-node").click();
  const editor = page.locator('[data-node-id][data-editing="true"]');
  await expect(editor).toBeVisible();
  await editor.locator("input").click();
  await page.keyboard.insertText("Created by browser test");
  const processorSelect = editor.locator("select");
  await processorSelect.focus();
  await processorSelect.selectOption("markdown");
  await page
    .locator('[data-node-id][data-editing="true"] textarea')
    .fill(syntheticContent);
  await page.getByTestId("graph-canvas").click({ position: { x: 30, y: 30 } });

  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      const created = stored?.nodes?.find(
        (candidate: { name?: string }) => candidate.name === "Created by browser test",
      );
      return created === undefined
        ? null
        : {
            content: created.content,
            processor: stored?.view?.contentProcessorByNodeId?.[created.id],
          };
    })
    .toEqual({
      content: syntheticContent,
      processor: "markdown",
    });

  await page.reload();
  await expect(page.locator('[data-node-id] strong', { hasText: "Created by browser test" })).toBeVisible();
  const createdNode = page.locator('[data-node-id]').filter({
    has: page.locator("strong", { hasText: "Created by browser test" }),
  });
  const markdown = createdNode.locator('[data-content-processor="markdown"]');
  await expect(markdown.locator("h1")).toHaveText("Persisted synthetic heading");
  await expect(markdown.locator("strong")).toHaveText("Formatted content");
  await expect(markdown.locator(".totp-content-code")).toHaveText(/^\d{6}$/);
  await expect(markdown).not.toContainText("jbsw");
  await expect(markdown.locator("script")).toHaveCount(0);
  await expect(markdown).not.toContainText("blocked");
});

test("node drag and pane pan persist their geometry", async ({ page }) => {
  const nodes = gridNodes(2, 1);
  await openSyntheticWorkspace(page, nodes);
  const firstNode = node(page, nodes[0].id);
  await expect(firstNode).toBeVisible();

  const beforeNode = await firstNode.boundingBox();
  expect(beforeNode).not.toBeNull();
  await firstNode.hover({ position: { x: 80, y: 30 } });
  await page.mouse.down();
  await page.mouse.move(beforeNode!.x + 200, beforeNode!.y + 110, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      const layout = stored?.layout?.find(
        (candidate: { nodeId?: string }) => candidate.nodeId === nodes[0].id,
      );
      return layout === undefined ? null : { x: layout.x, y: layout.y };
    })
    .not.toEqual({ x: nodes[0].x, y: nodes[0].y });

  const canvas = page.getByTestId("graph-canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + 35, bounds!.y + 35);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 155, bounds!.y + 105, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(async () => (await storedWorkspace(page))?.viewport)
    .not.toEqual({ x: 0, y: 0, zoom: 1 });
});

test("Shift-click keeps an explicit boundary around multiple selected nodes", async ({
  page,
}) => {
  const nodes = gridNodes(2, 2);
  await openSyntheticWorkspace(page, nodes);

  await expect(node(page, nodes[0].id)).toBeVisible();
  await node(page, nodes[0].id).click({ position: { x: 24, y: 24 } });
  await node(page, nodes[1].id).click({
    modifiers: ["Shift"],
    position: { x: 24, y: 24 },
  });

  await expect(node(page, nodes[0].id)).toHaveAttribute("data-selected", "true");
  await expect(node(page, nodes[1].id)).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("selected-node-boundary")).toBeVisible();
});

test("Shift marquee remains narrow while auto-panning and never selects the full graph", async ({
  page,
}) => {
  const nodes = gridNodes(10, 50);
  await openSyntheticWorkspace(page, nodes);
  const canvas = page.getByTestId("graph-canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (bounds === null) {
    return;
  }

  await page.keyboard.down("Shift");
  await page.mouse.move(bounds.x + 45, bounds.y + 45);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 395, bounds.y + bounds.height - 4, { steps: 12 });
  await expect(page.getByTestId("canvas-selection-marquee")).toBeVisible();
  await page.waitForTimeout(350);
  await page.mouse.up();
  await page.keyboard.up("Shift");

  await expect(page.getByTestId("canvas-selection-marquee")).toHaveCount(0);
  const boundary = page.getByTestId("selected-node-boundary");
  await expect(boundary).toBeVisible();
  const boundaryBox = await boundary.boundingBox();
  expect(boundaryBox).not.toBeNull();
  expect(boundaryBox!.width).toBeLessThan(340);

  const visibleSelected = page.locator('[data-node-id][data-selected="true"]');
  expect(await visibleSelected.count()).toBeGreaterThan(1);
  for (const id of await visibleSelected.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-node-id")),
  )) {
    const source = nodes.find((candidate) => candidate.id === id);
    expect(source?.x).toBe(100);
  }
});

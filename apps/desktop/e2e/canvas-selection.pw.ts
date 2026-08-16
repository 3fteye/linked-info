import { expect, test, type Page } from "@playwright/test";

interface SyntheticNode {
  content?: string;
  id: string;
  name: string;
  x: number;
  y: number;
}

interface SyntheticReference {
  sourceNodeId: string;
  targetNodeId: string;
}

interface SyntheticViewport {
  x: number;
  y: number;
  zoom: number;
}

const workspaceStorageKey = "linked-info.workspace.v1";
const workspaceRecoveryStorageKey = "linked-info.workspace.recovery.v1";

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

async function openSyntheticWorkspace(
  page: Page,
  nodes: SyntheticNode[],
  references: SyntheticReference[] = [],
  viewport: SyntheticViewport = { x: 0, y: 0, zoom: 1 },
) {
  await page.addInitScript(
    ({ storageKey, syntheticNodes, syntheticReferences, syntheticViewport }) => {
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
            content: node.content ?? `Generated test content for ${node.name}`,
          })),
          layout: syntheticNodes.map((node) => ({
            nodeId: node.id,
            x: node.x,
            y: node.y,
          })),
          references: syntheticReferences,
          viewport: syntheticViewport,
          view: { contentProcessorByNodeId: {} },
        }),
      );
      sessionStorage.setItem(seedMarker, "true");
    },
    {
      storageKey: workspaceStorageKey,
      syntheticNodes: nodes,
      syntheticReferences: references,
      syntheticViewport: viewport,
    },
  );
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  await expect(page.getByTestId("graph-canvas")).toHaveAttribute(
    "data-flow-ready",
    "true",
  );
}

async function openSyntheticWorkspaceWithRecovery(
  page: Page,
  current: SyntheticNode[],
  recovery: SyntheticNode[],
) {
  await page.addInitScript(
    ({ primaryKey, recoveryKey, currentNodes, recoveryNodes }) => {
      const snapshot = (nodes: SyntheticNode[]) => ({
        version: 2,
        nodes: nodes.map((node) => ({
          id: node.id,
          name: node.name,
          content: node.content ?? `Generated test content for ${node.name}`,
        })),
        layout: nodes.map((node) => ({ nodeId: node.id, x: node.x, y: node.y })),
        references: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        view: { contentProcessorByNodeId: {} },
      });
      localStorage.clear();
      localStorage.setItem(primaryKey, JSON.stringify(snapshot(currentNodes)));
      localStorage.setItem(recoveryKey, JSON.stringify(snapshot(recoveryNodes)));
    },
    {
      primaryKey: workspaceStorageKey,
      recoveryKey: workspaceRecoveryStorageKey,
      currentNodes: current,
      recoveryNodes: recovery,
    },
  );
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toHaveAttribute(
    "data-flow-ready",
    "true",
  );
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

async function selectAllTextarea(page: Page) {
  const textarea = page.locator('[data-node-id][data-editing="true"] textarea');
  const expectedSelection = await textarea.inputValue();
  await textarea.focus();
  await page.keyboard.press("Control+A");
  await expect
    .poll(() =>
      textarea.evaluate((element) => {
        const input = element as HTMLTextAreaElement;
        return input.value.slice(input.selectionStart, input.selectionEnd);
      }),
    )
    .toBe(expectedSelection);
}

async function placeCaretInsideTextareaText(page: Page, text: string) {
  const textarea = page.locator('[data-node-id][data-editing="true"] textarea');
  await textarea.evaluate((element, selectedText) => {
    const input = element as HTMLTextAreaElement;
    const start = input.value.indexOf(selectedText);
    if (start < 0) {
      throw new Error("synthetic caret target is missing");
    }
    input.focus();
    input.setSelectionRange(start, start);
  }, text);
  await page.keyboard.press("ArrowRight");
}

test("creating and editing a node survives a browser reload", async ({ page }) => {
  await openSyntheticWorkspace(page, gridNodes(1, 1));
  const syntheticTotp = "jbsw y3dp ehpk 3pxp";
  const syntheticSecret = "synthetic-api-key";
  const unmarkedContent = [
    "# Persisted synthetic heading",
    "",
    "**Formatted content**",
    "",
    `2FA ${syntheticTotp}, retained note`,
    "",
    `API ${syntheticSecret} retained`,
    "",
    "<script>blocked</script>",
  ].join("\n");
  const syntheticContent = unmarkedContent
    .replace(syntheticTotp, `[[li:totp]]${syntheticTotp}[[/li]]`)
    .replace(syntheticSecret, `[[li:secret]]${syntheticSecret}[[/li]]`);

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
  await expect(markdown).toContainText("retained note");
  await expect(markdown).not.toContainText(syntheticTotp);
  const secret = markdown.locator(".secret-content");
  await expect(secret).toBeVisible();
  await expect(markdown).not.toContainText(syntheticSecret);
  await secret.getByRole("button", { name: "Reveal" }).click();
  await expect(secret).toContainText(syntheticSecret);
  await secret.getByRole("button", { name: "Hide" }).click();
  await expect(secret).not.toContainText(syntheticSecret);
  await expect(markdown.locator("script")).toHaveCount(0);
  await expect(markdown).not.toContainText("blocked");
});

test("TOTP clock updates keep the rendered line geometry stable", async ({ page }) => {
  await page.addInitScript(() => {
    const startedAt = performance.now();
    Date.now = () => 298_000 + (performance.now() - startedAt);
  });
  const totpNode: SyntheticNode = {
    content:
      "prefix prefix [[li:totp]]otpauth://totp/Synthetic?secret=JBSWY3DPEHPK3PXP&period=300[[/li]] retained",
    id: syntheticId(1),
    name: "Stable TOTP geometry",
    x: 100,
    y: 100,
  };
  const targetNode: SyntheticNode = {
    id: syntheticId(2),
    name: "Synthetic target",
    x: 520,
    y: 100,
  };
  await openSyntheticWorkspace(page, [totpNode, targetNode], [
    { sourceNodeId: totpNode.id, targetNodeId: targetNode.id },
  ]);
  const line = node(page, totpNode.id).locator(".totp-content-line");
  const referencePath = page.locator(".graph-reference-path").first();
  await expect(line).toHaveAttribute("data-status", "ready");
  await expect(referencePath).toHaveAttribute("d", /^M/u);

  const samples = await page.evaluate(async (sourceNodeId) => {
    const sourceNode = document.querySelector(`[data-node-id="${sourceNodeId}"]`);
    const totpLine = sourceNode?.querySelector(".totp-content-line");
    const path = document.querySelector(".graph-reference-path");
    if (sourceNode === null || totpLine === null || path === null) {
      throw new Error("synthetic TOTP geometry targets are missing");
    }
    const geometry: Array<{ lineWidth: number; nodeHeight: number; path: string }> = [];
    const deadline = performance.now() + 2_500;
    while (performance.now() < deadline) {
      geometry.push({
        lineWidth: totpLine.getBoundingClientRect().width,
        nodeHeight: sourceNode.getBoundingClientRect().height,
        path: path.getAttribute("d") ?? "",
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return geometry;
  }, totpNode.id);
  const lineWidths = samples.map((sample) => sample.lineWidth);
  const nodeHeights = samples.map((sample) => sample.nodeHeight);
  expect(Math.max(...lineWidths) - Math.min(...lineWidths)).toBeLessThan(0.5);
  expect(Math.max(...nodeHeights) - Math.min(...nodeHeights)).toBeLessThan(0.5);
  expect(new Set(samples.map((sample) => sample.path)).size).toBe(1);
});

test("low-zoom TOTP updates keep every connected path stable", async ({ page }) => {
  await page.addInitScript(() => {
    const secondTimerDelays: number[] = [];
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...arguments_: unknown[]
    ) => {
      if (
        timeout !== undefined &&
        timeout >= 50 &&
        timeout <= 1_050 &&
        (new Error().stack ?? "").includes("/totpContent.tsx")
      ) {
        secondTimerDelays.push(timeout);
      }
      return nativeSetTimeout(handler, timeout, ...arguments_);
    }) as typeof window.setTimeout;
    Reflect.set(window, "__linkedInfoSecondTimerDelays", secondTimerDelays);
    const startedAt = performance.now();
    Date.now = () => 298_000 + (performance.now() - startedAt);
  });
  const nodes = gridNodes(6, 5).map((item, index) => ({
    ...item,
    content:
      index % 2 === 0
        ? [
            `Synthetic account ${index + 1} with a deliberately long description`,
            "[[li:totp]]otpauth://totp/Synthetic?secret=JBSWY3DPEHPK3PXP&period=300[[/li]]",
            "retained trailing content that wraps inside the canvas node",
          ].join("\n")
        : `Synthetic target content ${index + 1}`,
  }));
  const references = nodes.slice(1).map((item, index) => ({
    sourceNodeId: nodes[index].id,
    targetNodeId: item.id,
  }));
  await openSyntheticWorkspace(page, nodes, references, {
    x: 80,
    y: 70,
    zoom: 0.25,
  });
  await expect(page.locator(".totp-content-line").first()).toHaveAttribute(
    "data-status",
    "ready",
  );
  await expect(page.locator(".totp-content-line")).toHaveCount(15);
  await expect(page.locator(".graph-reference-path").first()).toHaveAttribute("d", /^M/u);
  const secondTimerCount = await page.evaluate(() =>
    (Reflect.get(window, "__linkedInfoSecondTimerDelays") as number[]).length,
  );
  expect(secondTimerCount).toBeLessThanOrEqual(2);

  const samples = await page.evaluate(async () => {
    const geometry: Array<{
      nodeRects: string;
      pathBounds: string;
      paths: string;
      viewportTransform: string;
    }> = [];
    const deadline = performance.now() + 2_500;
    while (performance.now() < deadline) {
      const nodeRects = Array.from(document.querySelectorAll("[data-node-id]"))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return `${element.getAttribute("data-node-id")}:${rect.x},${rect.y},${rect.width},${rect.height}`;
        })
        .join("|");
      const paths = Array.from(document.querySelectorAll(".graph-reference-path"))
        .map((element) => element.getAttribute("d") ?? "")
        .join("|");
      const pathBounds = Array.from(document.querySelectorAll(".graph-reference-path"))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return `${rect.x},${rect.y},${rect.width},${rect.height}`;
        })
        .join("|");
      geometry.push({
        nodeRects,
        pathBounds,
        paths,
        viewportTransform:
          document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "",
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return geometry;
  });

  expect(new Set(samples.map((sample) => sample.nodeRects)).size).toBe(1);
  expect(new Set(samples.map((sample) => sample.paths)).size).toBe(1);
  expect(new Set(samples.map((sample) => sample.pathBounds)).size).toBe(1);
  expect(new Set(samples.map((sample) => sample.viewportTransform)).size).toBe(1);
});

test("existing content markers can be changed or removed without nesting", async ({
  page,
}) => {
  const syntheticTotp = "JBSW Y3DP EHPK 3PXP";
  const invalidTotp = "synthetic-invalid-key";
  const original = `valid ${syntheticTotp}; invalid ${invalidTotp}`;
  const markedNode = {
    content: `valid [[li:secret]]${syntheticTotp}[[/li]]; invalid ${invalidTotp}`,
    id: syntheticId(1),
    name: "Marker lifecycle",
    x: 100,
    y: 100,
  };
  await openSyntheticWorkspace(page, [markedNode]);
  await node(page, markedNode.id).dblclick({ position: { x: 80, y: 24 } });
  const textarea = page.locator('[data-node-id][data-editing="true"] textarea');
  await expect(textarea).toBeVisible();
  await placeCaretInsideTextareaText(page, syntheticTotp);
  const secretToolbar = page.getByLabel("Current marker: Secret");
  await expect(secretToolbar).toBeVisible();
  await expect(secretToolbar.getByRole("button", { name: "Secret" })).toBeDisabled();
  await secretToolbar.getByRole("button", { name: "TOTP" }).click();
  await expect(textarea).toHaveValue(
    `valid [[li:totp]]${syntheticTotp}[[/li]]; invalid ${invalidTotp}`,
  );

  await selectAllTextarea(page);
  await expect(page.getByRole("alert")).toHaveText(
    "The selection crosses content marker boundaries. Edit one complete marker at a time.",
  );
  await expect(page.locator(".graph-node-content-marker-toolbar")).toHaveCount(0);

  await placeCaretInsideTextareaText(page, syntheticTotp);
  const totpToolbar = page.getByLabel("Current marker: TOTP");
  await expect(totpToolbar).toBeVisible();
  await totpToolbar.getByRole("button", { name: "Remove marker" }).click();
  await expect(textarea).toHaveValue(original);
});

test("invalid TOTP content is rejected without changing the node", async ({ page }) => {
  const invalidTotp = "synthetic-invalid-key";
  const invalidNode = {
    content: invalidTotp,
    id: syntheticId(1),
    name: "Invalid TOTP",
    x: 100,
    y: 100,
  };
  await openSyntheticWorkspace(page, [invalidNode]);
  await node(page, invalidNode.id).dblclick({ position: { x: 80, y: 24 } });
  const textarea = page.locator('[data-node-id][data-editing="true"] textarea');
  await expect(textarea).toBeVisible();
  await selectAllTextarea(page);
  await page
    .locator(".graph-node-content-marker-toolbar")
    .getByRole("button", { name: "TOTP" })
    .click();
  await expect(page.getByRole("alert")).toHaveText("Invalid TOTP secret");
  await expect(textarea).toHaveValue(invalidTotp);
});

test("Space plus left drag pans from a node without moving it", async ({ page }) => {
  const nodes = gridNodes(2, 1);
  await openSyntheticWorkspace(page, nodes);
  const firstNode = node(page, nodes[0].id);
  const beforeNode = await firstNode.boundingBox();
  expect(beforeNode).not.toBeNull();

  await page.keyboard.down("Space");
  await page.mouse.move(beforeNode!.x + 90, beforeNode!.y + 28);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(beforeNode!.x + 230, beforeNode!.y + 108, { steps: 8 });
  await page.mouse.up({ button: "left" });
  await page.keyboard.up("Space");

  await expect
    .poll(async () => (await storedWorkspace(page))?.viewport)
    .not.toEqual({ x: 0, y: 0, zoom: 1 });
  expect((await storedWorkspace(page))?.layout).toEqual(
    nodes.map((item) => ({ nodeId: item.id, x: item.x, y: item.y })),
  );
});

test("middle drag pans from a node without moving it", async ({ page }) => {
  const nodes = gridNodes(2, 1);
  await openSyntheticWorkspace(page, nodes);
  const firstNode = node(page, nodes[0].id);
  const beforeNode = await firstNode.boundingBox();
  expect(beforeNode).not.toBeNull();

  await page.mouse.move(beforeNode!.x + 90, beforeNode!.y + 28);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(beforeNode!.x + 230, beforeNode!.y + 108, { steps: 8 });
  await page.mouse.up({ button: "middle" });

  await expect
    .poll(async () => (await storedWorkspace(page))?.viewport)
    .not.toEqual({ x: 0, y: 0, zoom: 1 });
  expect((await storedWorkspace(page))?.layout).toEqual(
    nodes.map((item) => ({ nodeId: item.id, x: item.x, y: item.y })),
  );
});

test("canvas keyboard navigation frames and zooms the current view", async ({ page }) => {
  const nodes = gridNodes(6, 4);
  await openSyntheticWorkspace(page, nodes);

  await page.getByTestId("graph-canvas").click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Home");
  await expect
    .poll(async () => (await storedWorkspace(page))?.viewport?.zoom ?? null)
    .toBeLessThan(1);
  const fittedZoom = (await storedWorkspace(page))!.viewport!.zoom;

  await node(page, nodes[0].id).click({ position: { x: 24, y: 24 } });
  await page.keyboard.press("f");
  await expect
    .poll(async () => (await storedWorkspace(page))?.viewport?.zoom ?? null)
    .toBeGreaterThan(fittedZoom);

  await page.keyboard.press("Control+0");
  await expect
    .poll(async () => (await storedWorkspace(page))?.viewport?.zoom ?? null)
    .toBeCloseTo(1, 3);

  await page.keyboard.press("-");
  await expect
    .poll(async () => (await storedWorkspace(page))?.viewport?.zoom ?? null)
    .toBeLessThan(1);
  await page.keyboard.press("+");
  await expect
    .poll(async () => (await storedWorkspace(page))?.viewport?.zoom ?? null)
    .toBeCloseTo(1, 2);
});

test("canvas shortcut help exposes the complete interaction baseline", async ({ page }) => {
  await openSyntheticWorkspace(page, gridNodes(2, 1));
  const toggle = page.getByTestId("canvas-shortcuts-toggle");
  const popover = page.getByTestId("canvas-shortcuts-popover");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(popover).toBeVisible();
  await expect(popover.locator("dt")).toHaveCount(11);
  const canvasBounds = await page.getByTestId("graph-canvas").boundingBox();
  const popoverBounds = await popover.boundingBox();
  expect(canvasBounds).not.toBeNull();
  expect(popoverBounds).not.toBeNull();
  expect(popoverBounds!.x).toBeGreaterThan(canvasBounds!.x + canvasBounds!.width / 2);
  expect(popoverBounds!.x + popoverBounds!.width).toBeLessThanOrEqual(
    canvasBounds!.x + canvasBounds!.width,
  );
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);

  await page.getByTestId("graph-canvas").click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("?");
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
});

test("canvas keyboard selection, editing, search and control focus do not conflict", async ({
  page,
}) => {
  const nodes = gridNodes(2, 1);
  await openSyntheticWorkspace(page, nodes);
  const firstNode = node(page, nodes[0].id);

  await firstNode.click({ position: { x: 24, y: 24 } });
  await expect(firstNode).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Enter");
  await expect(firstNode).toHaveAttribute("data-editing", "true");
  const nameInput = firstNode.locator("input").first();
  await nameInput.fill("Keyboard edited synthetic node");
  await page.keyboard.press("Escape");
  await expect(firstNode).toHaveAttribute("data-editing", "false");
  await expect
    .poll(async () =>
      (await storedWorkspace(page))?.nodes?.find(
        (item: { id?: string }) => item.id === nodes[0].id,
      )?.name,
    )
    .toBe("Keyboard edited synthetic node");

  await page.keyboard.press("Escape");
  await expect(firstNode).toHaveAttribute("data-selected", "false");

  const searchInput = page.getByTestId("node-search");
  await searchInput.fill("Synthetic");
  await page.getByTestId("graph-canvas").click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Control+f");
  await expect(searchInput).toBeFocused();
  await expect
    .poll(() =>
      searchInput.evaluate((element) => {
        const input = element as HTMLInputElement;
        return input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);
      }),
    )
    .toBe("Synthetic");
  await page.keyboard.press("Escape");
  await expect(searchInput).toHaveValue("");
  await expect(searchInput).not.toBeFocused();

  await firstNode.click({ position: { x: 24, y: 24 } });
  await page.getByTestId("create-node").focus();
  await page.keyboard.press("Delete");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(firstNode).toHaveAttribute("data-selected", "true");
});

test("search scope and unmatched opacity preserve canvas context", async ({ page }) => {
  const nodes = gridNodes(3, 1).map((item, index) => ({
    ...item,
    content:
      index === 1
        ? "content-only match"
        : index === 2
          ? "[[li:secret]]synthetic-hidden-value[[/li]]"
          : "ordinary content",
  }));
  await openSyntheticWorkspace(page, nodes, [
    { sourceNodeId: nodes[0].id, targetNodeId: nodes[1].id },
  ]);

  const searchInput = page.getByTestId("node-search");
  const searchScope = page.getByTestId("node-search-scope");
  const opacity = page.getByTestId("unmatched-node-opacity");
  const firstFlowNode = page.locator(`.react-flow__node[data-id="${nodes[0].id}"]`);
  const secondFlowNode = page.locator(`.react-flow__node[data-id="${nodes[1].id}"]`);

  await searchInput.fill(nodes[0].name);
  await expect(firstFlowNode).toHaveCSS("opacity", "1");
  await expect(secondFlowNode).toHaveCSS("opacity", "0.2");
  await expect(page.locator(".item-count")).toContainText("1 / 3");
  await expect(page.locator(".graph-reference-path-dimmed")).toHaveCount(1);
  await expect(page.locator(".graph-reference-path-dimmed")).toHaveCSS(
    "opacity",
    "0.2",
  );

  const secondCard = node(page, nodes[1].id);
  await expect(secondCard).toHaveAttribute("aria-disabled", "true");
  await expect(secondCard).toHaveAttribute("data-interactive", "false");
  await expect(secondFlowNode).toHaveCSS("pointer-events", "none");
  const secondBounds = await secondCard.boundingBox();
  expect(secondBounds).not.toBeNull();
  await page.mouse.click(secondBounds!.x + 70, secondBounds!.y + 28);
  await expect(secondCard).toHaveAttribute("data-selected", "false");

  await page.mouse.dblclick(secondBounds!.x + 70, secondBounds!.y + 28);
  await expect(secondCard).toHaveAttribute("data-editing", "false");

  await page.mouse.click(secondBounds!.x + 70, secondBounds!.y + 28, {
    button: "right",
  });
  await expect(page.locator('.graph-context-menu[data-kind="pane"]')).toBeVisible();
  await page.keyboard.press("Escape");

  const originalSecondLayout = (await storedWorkspace(page))?.layout?.find(
    (candidate: { nodeId?: string }) => candidate.nodeId === nodes[1].id,
  );
  await page.mouse.move(secondBounds!.x + 70, secondBounds!.y + 28);
  await page.mouse.down();
  await page.mouse.move(secondBounds!.x + 150, secondBounds!.y + 85, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(450);
  expect(
    (await storedWorkspace(page))?.layout?.find(
      (candidate: { nodeId?: string }) => candidate.nodeId === nodes[1].id,
    ),
  ).toEqual(originalSecondLayout);

  const dimmedPathPoint = await page
    .locator(".graph-reference-path-dimmed")
    .evaluate((element) => {
      const path = element as SVGPathElement;
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      const matrix = path.getScreenCTM();
      if (matrix === null) {
        throw new Error("missing path screen transform");
      }
      const screenPoint = new DOMPoint(point.x, point.y).matrixTransform(matrix);
      return { x: screenPoint.x, y: screenPoint.y };
    });
  await page.mouse.click(dimmedPathPoint.x, dimmedPathPoint.y);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(350);
  expect((await storedWorkspace(page))?.references).toHaveLength(1);

  await page.getByTestId("graph-canvas").click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Control+a");
  await expect(page.locator('[data-node-id][data-selected="true"]')).toHaveCount(1);
  await expect(firstFlowNode.locator("[data-node-id]")).toHaveAttribute(
    "data-selected",
    "true",
  );

  await opacity.fill("0");
  await expect(secondFlowNode).toBeHidden();
  await expect(page.locator(".graph-reference-path-dimmed")).toHaveCount(0);

  await opacity.fill("35");
  await expect(secondFlowNode).toBeVisible();
  await expect(secondFlowNode).toHaveCSS("opacity", "0.35");

  await searchInput.fill("content-only match");
  await expect(page.locator(".item-count")).toContainText("0 / 3");
  await searchScope.selectOption("content");
  await expect(secondFlowNode).toHaveCSS("opacity", "1");
  await expect(firstFlowNode).toHaveCSS("opacity", "0.35");
  await expect(page.locator(".item-count")).toContainText("1 / 3");

  await searchInput.fill("synthetic-hidden-value");
  await expect(page.locator(".item-count")).toContainText("0 / 3");
});

test("canvas select all, delete, undo, redo and context menu share one keyboard model", async ({
  page,
}) => {
  const nodes = gridNodes(3, 1);
  await openSyntheticWorkspace(page, nodes);
  const canvas = page.getByTestId("graph-canvas");

  await canvas.click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Control+a");
  await expect(page.locator('[data-node-id][data-selected="true"]')).toHaveCount(3);

  await page.keyboard.press("Delete");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.keyboard.press("Backspace");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.locator(".confirmation-dialog .danger-button").click();
  await expect(page.locator("[data-node-id]")).toHaveCount(0);

  await canvas.click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-node-id]")).toHaveCount(3);
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator("[data-node-id]")).toHaveCount(0);

  await page.keyboard.press("Control+z");
  const firstNode = node(page, nodes[0].id);
  await firstNode.click({ button: "right", position: { x: 30, y: 30 } });
  await expect(page.locator(".graph-context-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".graph-context-menu")).toHaveCount(0);
});

test("settings operation guide demonstrates every shared canvas control", async ({ page }) => {
  await openSyntheticWorkspace(page, gridNodes(2, 1));
  await page.getByTestId("settings-navigation").click();
  await expect(page.getByTestId("settings-tab-general")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator('[role="tabpanel"]:not([hidden])')).toHaveAttribute(
    "id",
    "settings-panel-general",
  );
  await page.getByTestId("settings-tab-operations").click();
  await expect(page.getByTestId("settings-tab-operations")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const guide = page.getByTestId("canvas-operation-guide");
  const stage = page.getByTestId("canvas-operation-stage");
  await expect(page.getByTestId("operation-guide-heading")).toBeVisible();
  await expect(guide).toBeVisible();
  await expect(guide.locator(".canvas-operation-picker-item")).toHaveCount(11);

  const animatedTargets: Record<string, string> = {
    pan: ".canvas-operation-scene",
    zoom: ".canvas-operation-scene",
    frame: ".canvas-operation-scene",
    select: ".canvas-operation-marquee",
    selectAll: ".canvas-operation-node-a",
    edit: ".canvas-operation-editor",
    search: ".canvas-operation-search",
    history: ".canvas-operation-node-c",
    contextMenu: ".canvas-operation-context-menu",
    cancel: ".canvas-operation-node-b",
    help: ".canvas-operation-help",
  };
  for (const [operation, selector] of Object.entries(animatedTargets)) {
    await guide.locator(`[data-operation="${operation}"]`).click();
    await expect(stage).toHaveAttribute("data-demo", operation);
    await expect
      .poll(() =>
        stage.locator(selector).evaluate((element) =>
          getComputedStyle(element).animationName,
        ),
      )
      .not.toBe("none");
  }

  const beforeReplay = Number(await stage.getAttribute("data-replay-iteration"));
  await guide.getByTestId("canvas-operation-replay").click();
  await expect(stage).toHaveAttribute(
    "data-replay-iteration",
    String(beforeReplay + 1),
  );

  const guideBounds = await guide.boundingBox();
  const stageBounds = await stage.boundingBox();
  expect(guideBounds).not.toBeNull();
  expect(stageBounds).not.toBeNull();
  expect(stageBounds!.x + stageBounds!.width).toBeLessThanOrEqual(
    guideBounds!.x + guideBounds!.width,
  );

  await page.getByTestId("settings-tab-general").click();
  await page.locator('[data-language="en-US"]').click();
  await page.getByTestId("settings-tab-operations").click();
  await expect(page.getByTestId("operation-guide-heading")).toHaveText(
    "Operation guide",
  );
  await expect(guide.locator(".canvas-operation-picker-item")).toHaveCount(11);
});

test("settings operation guide honors reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSyntheticWorkspace(page, gridNodes(1, 1));
  await page.getByTestId("settings-navigation").click();
  await page.getByTestId("settings-tab-operations").click();
  const guide = page.getByTestId("canvas-operation-guide");
  await guide.locator('[data-operation="contextMenu"]').click();

  await expect
    .poll(() =>
      guide.locator(".canvas-operation-context-menu").evaluate((element) =>
        getComputedStyle(element).animationName,
      ),
    )
    .toBe("none");
  await expect
    .poll(() =>
      guide.locator(".canvas-operation-context-menu").evaluate((element) =>
        getComputedStyle(element).opacity,
      ),
    )
    .toBe("1");
  await expect
    .poll(() =>
      guide.locator(".canvas-operation-key-state").evaluate((element) =>
        getComputedStyle(element).animationName,
      ),
    )
    .toBe("none");
});

test("settings tabs support standard keyboard navigation", async ({ page }) => {
  await openSyntheticWorkspace(page, gridNodes(1, 1));
  await page.getByTestId("settings-navigation").click();

  const generalTab = page.getByTestId("settings-tab-general");
  await generalTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("settings-tab-operations")).toBeFocused();
  await expect(page.locator('[role="tabpanel"]:not([hidden])')).toHaveAttribute(
    "id",
    "settings-panel-operations",
  );

  await page.keyboard.press("End");
  await expect(page.getByTestId("settings-tab-dataSecurity")).toBeFocused();
  await expect(page.locator('[role="tabpanel"]:not([hidden])')).toHaveAttribute(
    "id",
    "settings-panel-dataSecurity",
  );

  await page.keyboard.press("Home");
  await expect(generalTab).toBeFocused();
  await expect(page.locator('[role="tabpanel"]:not([hidden])')).toHaveAttribute(
    "id",
    "settings-panel-general",
  );
});

test("confirmed workspace replacement can be undone and redone from disk", async ({
  page,
}) => {
  const current = {
    id: syntheticId(901),
    name: "Current workspace",
    x: 120,
    y: 100,
  };
  const recovery = {
    id: syntheticId(902),
    name: "Recovery workspace",
    x: 520,
    y: 320,
  };
  await openSyntheticWorkspaceWithRecovery(page, [current], [recovery]);

  await page.getByTestId("settings-navigation").click();
  await page.getByTestId("settings-tab-dataSecurity").click();
  await page.getByTestId("restore-recovery-workspace").click();
  await expect(page.getByTestId("workspace-restore-preview")).toBeVisible();
  await page.getByTestId("workspace-restore-confirm").click();

  await expect(node(page, recovery.id)).toBeVisible();
  await expect(node(page, current.id)).toHaveCount(0);
  await expect(page.getByTestId("app-notice-action")).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(node(page, current.id)).toBeVisible();
  await expect(node(page, recovery.id)).toHaveCount(0);
  await page.keyboard.press("Control+y");
  await expect(node(page, recovery.id)).toBeVisible();
  await expect(node(page, current.id)).toHaveCount(0);
});

test("offsite backup exposes Cloudflare R2 through the shared S3 form", async ({ page }) => {
  await openSyntheticWorkspace(page, gridNodes(1, 1));
  await page.getByTestId("settings-navigation").click();
  await page.getByTestId("settings-tab-dataSecurity").click();

  const provider = page.getByTestId("offsite-s3-provider");
  await expect(provider.locator("option")).toHaveCount(5);
  await expect(provider).toHaveValue("cloudflareR2");
  await expect(page.getByTestId("offsite-s3-region")).toHaveValue("auto");
  await expect(page.getByTestId("offsite-s3-endpoint")).toHaveAttribute(
    "placeholder",
    "https://<ACCOUNT_ID>.r2.cloudflarestorage.com",
  );
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

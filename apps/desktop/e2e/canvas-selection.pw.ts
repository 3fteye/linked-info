import { expect, test, type Page } from "@playwright/test";

interface SyntheticNode {
  content?: string;
  height?: number;
  id: string;
  name: string;
  width?: number;
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
  extensionMetadata: Record<string, unknown> | null = null,
) {
  await page.addInitScript(
    ({
      storageKey,
      syntheticExtensionMetadata,
      syntheticNodes,
      syntheticReferences,
      syntheticViewport,
    }) => {
      const seedMarker = `${storageKey}.playwright-seeded`;
      if (sessionStorage.getItem(seedMarker) === "true") {
        return;
      }
      localStorage.clear();
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          version: syntheticExtensionMetadata === null ? 2 : 3,
          nodes: syntheticNodes.map((node) => ({
            id: node.id,
            name: node.name,
            content: node.content ?? `Generated test content for ${node.name}`,
          })),
          layout: syntheticNodes.map((node) => ({
            nodeId: node.id,
            x: node.x,
            y: node.y,
            ...(node.width === undefined ? {} : { width: node.width }),
            ...(node.height === undefined ? {} : { height: node.height }),
          })),
          references: syntheticReferences,
          viewport: syntheticViewport,
          view: {
            contentProcessorByNodeId: {},
            ...(syntheticExtensionMetadata === null
              ? {}
              : { extensionMetadata: syntheticExtensionMetadata }),
          },
        }),
      );
      sessionStorage.setItem(seedMarker, "true");
    },
    {
      storageKey: workspaceStorageKey,
      syntheticExtensionMetadata: extensionMetadata,
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
    if (raw === null) {
      return null;
    }
    const stored = JSON.parse(raw);
    const activeCanvas = stored?.view?.canvases?.find(
      (canvas: { id: string }) => canvas.id === stored.view.activeCanvasId,
    );
    return {
      ...stored,
      layout: activeCanvas?.layout ?? stored.layout,
      viewport:
        activeCanvas === undefined ? stored.viewport : activeCanvas.viewport,
    };
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
    const activeSecondTimers = new Set<number>();
    const secondTimerStats = {
      maximumConcurrent: 0,
      scheduled: 0,
    };
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    window.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...arguments_: unknown[]
    ) => {
      const tracksSecondClock =
        timeout !== undefined &&
        timeout >= 50 &&
        timeout <= 1_050 &&
        (new Error().stack ?? "").includes("/totpContent.tsx");
      if (!tracksSecondClock || typeof handler !== "function") {
        return nativeSetTimeout(handler, timeout, ...arguments_);
      }

      let timerId = 0;
      timerId = nativeSetTimeout(
        (...callbackArguments: unknown[]) => {
          activeSecondTimers.delete(timerId);
          handler(...callbackArguments);
        },
        timeout,
        ...arguments_,
      );
      activeSecondTimers.add(timerId);
      secondTimerStats.scheduled += 1;
      secondTimerStats.maximumConcurrent = Math.max(
        secondTimerStats.maximumConcurrent,
        activeSecondTimers.size,
      );
      return timerId;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((timerId?: number) => {
      if (timerId !== undefined) {
        activeSecondTimers.delete(timerId);
      }
      nativeClearTimeout(timerId);
    }) as typeof window.clearTimeout;
    Reflect.set(window, "__linkedInfoSecondTimerStats", secondTimerStats);
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
  const secondTimerStats = await page.evaluate(
    () =>
      Reflect.get(window, "__linkedInfoSecondTimerStats") as {
        maximumConcurrent: number;
        scheduled: number;
      },
  );

  expect(secondTimerStats.scheduled).toBeGreaterThan(0);
  expect(secondTimerStats.maximumConcurrent).toBeLessThanOrEqual(1);
  expect(new Set(samples.map((sample) => sample.nodeRects)).size).toBe(1);
  expect(new Set(samples.map((sample) => sample.paths)).size).toBe(1);
  expect(new Set(samples.map((sample) => sample.pathBounds)).size).toBe(1);
  expect(new Set(samples.map((sample) => sample.viewportTransform)).size).toBe(1);
});

test("an explicit code language highlights safely and survives reload", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://127.0.0.1:1422",
  });
  const codeNode = {
    content: Array.from({ length: 600 }, (_, index) =>
      index === 0
        ? `const answer: number = 42; // ${"x".repeat(800)}`
        : `const value${index}: number = ${index};`,
    ).join("\n"),
    height: 420,
    id: syntheticId(1),
    name: "TypeScript example",
    x: 100,
    y: 100,
  };
  await openSyntheticWorkspace(page, [codeNode]);
  await node(page, codeNode.id).dblclick({ position: { x: 80, y: 24 } });
  await page.getByLabel("Content format").selectOption("code.typescript");
  await page.locator(".react-flow__pane").click({ position: { x: 700, y: 500 } });

  const preview = node(page, codeNode.id).locator(".code-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("data-language", "typescript");
  await expect(preview.locator(".code-preview-line")).toHaveCount(500);
  await expect(preview.locator(".token.keyword").first()).toHaveText("const");
  await expect(preview).toHaveAttribute("data-truncated", "true");
  await expect(preview.locator(".code-preview-truncated")).toBeVisible();
  const scroll = preview.locator(".code-preview-scroll");
  const viewport = page.locator(".react-flow__viewport");
  const viewportTransform = await viewport.getAttribute("style");
  await scroll.hover();
  await page.mouse.wheel(400, 0);
  await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(viewport).toHaveAttribute("style", viewportTransform ?? "");
  await preview.locator(".code-preview-copy").click();
  await expect
    .poll(async () =>
      (await page.evaluate(() => navigator.clipboard.readText())).replace(
        /\r\n/gu,
        "\n",
      ),
    )
    .toBe(codeNode.content);
  await expect.poll(() => storedWorkspace(page)).toMatchObject({
    nodes: [{ content: codeNode.content, id: codeNode.id }],
    view: {
      contentProcessorByNodeId: { [codeNode.id]: "code.typescript" },
    },
  });

  await page.reload();
  await expect(node(page, codeNode.id).locator(".code-preview")).toHaveAttribute(
    "data-language",
    "typescript",
  );
});

test("the built-in JSON adapter persists one undoable namespaced preference", async ({
  page,
}) => {
  const jsonNode = {
    content: '{"outer":{"value":1}}',
    id: syntheticId(1),
    name: "JSON adapter",
    x: 100,
    y: 100,
  };
  const processorId = "app.linked-info.json-inspector.inspect";
  const extensionId = "app.linked-info.json-inspector";
  await openSyntheticWorkspace(page, [jsonNode]);
  await node(page, jsonNode.id).dblclick({ position: { x: 80, y: 24 } });
  await page.getByLabel("Content format").selectOption(processorId);
  await page.locator(".react-flow__pane").click({ position: { x: 700, y: 500 } });

  const presentation = node(page, jsonNode.id).locator(
    ".extension-presentation",
  );
  await expect(presentation.locator(".code-preview")).toHaveAttribute(
    "data-language",
    "json",
  );
  const indent = presentation.locator(".extension-presentation-select select");
  await expect(indent).toHaveValue("2");
  await indent.selectOption("4");
  await expect(indent).toHaveValue("4");
  await expect
    .poll(() => storedWorkspace(page))
    .toMatchObject({
      version: 4,
      view: {
        contentProcessorByNodeId: { [jsonNode.id]: processorId },
        extensionMetadata: {
          [extensionId]: {
            schemaVersion: 1,
            workspace: {},
            byNodeId: { [jsonNode.id]: { indentSize: 4 } },
          },
        },
      },
    });

  await page.locator(".react-flow__pane").click({ position: { x: 700, y: 500 } });
  await page.keyboard.press("Control+Z");
  await expect(indent).toHaveValue("2");
  await expect
    .poll(async () => (await storedWorkspace(page))?.view?.extensionMetadata)
    .toEqual({});

  await page.keyboard.press("Control+Y");
  await expect(indent).toHaveValue("4");
  await page.reload();
  await expect(
    node(page, jsonNode.id).locator(".extension-presentation-select select"),
  ).toHaveValue("4");
});

test("existing content markers can be changed or removed without nesting", async ({
  page,
}) => {
  const syntheticTotp = "JBSW Y3DP EHPK 3PXP";
  const invalidTotp = "synthetic-invalid-key";
  const restored = `valid OpenAI | 2FA: ${syntheticTotp}; invalid ${invalidTotp}`;
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
  const annotatedToolbar = page.getByLabel("Current marker: TOTP");
  await annotatedToolbar.getByRole("textbox", { name: "Description" }).fill(
    "OpenAI | 2FA",
  );
  await annotatedToolbar.getByRole("button", { name: "Save description" }).click();
  await expect(textarea).toHaveValue(
    `valid [[li:totp note="OpenAI | 2FA"]]${syntheticTotp}[[/li]]; invalid ${invalidTotp}`,
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
  await expect(textarea).toHaveValue(restored);
});

test("triple-clicking a marked line tolerates the selected line ending", async ({
  page,
}) => {
  const markedLine = "[[li:secret]]synthetic-value[[/li]]";
  const markedNode = {
    content: `${markedLine}\nnext line`,
    id: syntheticId(1),
    name: "Triple-click marker",
    x: 100,
    y: 100,
  };
  await openSyntheticWorkspace(page, [markedNode]);
  await node(page, markedNode.id).dblclick({ position: { x: 80, y: 24 } });
  const textarea = page.locator('[data-node-id][data-editing="true"] textarea');
  await expect(textarea).toBeVisible();

  await textarea.click({ clickCount: 3, position: { x: 60, y: 12 } });

  await expect
    .poll(() =>
      textarea.evaluate((element) => {
        const input = element as HTMLTextAreaElement;
        return input.value.slice(input.selectionStart, input.selectionEnd);
      }),
    )
    .toBe(`${markedLine}\n`);
  await expect(page.getByLabel("Current marker: Secret")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
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
    .toBeCloseTo(1 / 1.2, 2);
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
  await expect(popover.locator("dt")).toHaveCount(13);
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

test("reference search can target nodes outside the current canvas filter", async ({
  page,
}) => {
  const nodes = gridNodes(3, 1);
  await openSyntheticWorkspace(page, nodes);
  await page.getByTestId("node-search").fill(nodes[0].name);
  await page.getByTestId("unmatched-node-opacity").fill("0");

  const sourceHandle = node(page, nodes[0].id).locator(".graph-handle-source");
  const sourceBounds = await sourceHandle.boundingBox();
  const canvasBounds = await page.getByTestId("graph-canvas").boundingBox();
  expect(sourceBounds).not.toBeNull();
  expect(canvasBounds).not.toBeNull();

  await page.mouse.move(
    sourceBounds!.x + sourceBounds!.width / 2,
    sourceBounds!.y + sourceBounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    canvasBounds!.x + canvasBounds!.width / 2,
    canvasBounds!.y + canvasBounds!.height - 80,
    { steps: 8 },
  );
  await page.mouse.up();

  const referenceSearch = page.locator(".reference-search-popover");
  await expect(referenceSearch).toBeVisible();
  await expect(referenceSearch.locator(".reference-search-option")).toHaveCount(2);
  await referenceSearch
    .locator(".reference-search-option")
    .filter({ hasText: nodes[1].name })
    .click();
  await expect
    .poll(async () => (await storedWorkspace(page))?.references)
    .toContainEqual({ sourceNodeId: nodes[0].id, targetNodeId: nodes[1].id });
});

test("incoming reference browser finds and focuses hidden source nodes", async ({
  page,
}) => {
  const nodes = gridNodes(3, 1);
  await openSyntheticWorkspace(page, nodes, [
    { sourceNodeId: nodes[0].id, targetNodeId: nodes[2].id },
    { sourceNodeId: nodes[1].id, targetNodeId: nodes[2].id },
  ]);
  const searchInput = page.getByTestId("node-search");
  await searchInput.fill(nodes[2].name);
  await page.getByTestId("unmatched-node-opacity").fill("0");

  const firstSource = page.locator(
    `.react-flow__node[data-id="${nodes[0].id}"]`,
  );
  await expect(firstSource).toBeHidden();
  await node(page, nodes[2].id).locator(".graph-node-incoming-button").click();

  const browser = page.getByTestId("incoming-reference-browser");
  await expect(browser).toBeVisible();
  await expect(browser.locator(".incoming-reference-browser-list button")).toHaveCount(
    2,
  );
  await browser.locator(".incoming-reference-browser-search input").fill(
    nodes[0].name,
  );
  await expect(browser.locator(".incoming-reference-browser-list button")).toHaveCount(
    1,
  );
  await browser
    .locator(".incoming-reference-browser-list button")
    .filter({ hasText: nodes[0].name })
    .click();

  await expect(browser).toBeHidden();
  await expect(firstSource).toBeVisible();
  await expect(node(page, nodes[0].id)).toHaveAttribute("data-selected", "true");
  await expect(searchInput).toHaveValue(nodes[2].name);
  await expect(page.locator(".item-count")).toContainText("1 / 3");
});

test("double-clicking an inline reference filter leaves every node visible", async ({
  page,
}) => {
  const nodes = gridNodes(3, 1);
  await openSyntheticWorkspace(page, nodes, [
    { sourceNodeId: nodes[0].id, targetNodeId: nodes[1].id },
  ]);
  await page.getByTestId("unmatched-node-opacity").fill("0");

  const referenceChip = node(page, nodes[0].id).locator(
    ".graph-node-reference-filter",
  );
  await expect(referenceChip).toHaveCount(1);
  await referenceChip.dblclick();

  await expect(page.locator(".active-reference-filter")).toHaveCount(0);
  for (const syntheticNode of nodes) {
    await expect(
      page.locator(`.react-flow__node[data-id="${syntheticNode.id}"]`),
    ).toBeVisible();
  }
});

test("following inline references replaces the browsing filter instead of accumulating AND filters", async ({
  page,
}) => {
  const nodes = gridNodes(3, 1);
  await openSyntheticWorkspace(page, nodes, [
    { sourceNodeId: nodes[0].id, targetNodeId: nodes[1].id },
    { sourceNodeId: nodes[1].id, targetNodeId: nodes[2].id },
  ]);
  await page.getByTestId("unmatched-node-opacity").fill("0");

  await node(page, nodes[0].id).locator(".graph-node-reference-filter").click();
  await node(page, nodes[1].id).locator(".graph-node-reference-filter").click();

  await expect(page.locator(".active-reference-filter")).toHaveCount(1);
  await expect(page.locator(".item-count")).toContainText("1 / 3");
  await expect(
    page.locator(`.react-flow__node[data-id="${nodes[0].id}"]`),
  ).toBeHidden();
  await expect(
    page.locator(`.react-flow__node[data-id="${nodes[1].id}"]`),
  ).toBeVisible();
  await expect(
    page.locator(`.react-flow__node[data-id="${nodes[2].id}"]`),
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".active-reference-filter")).toHaveCount(0);
  await expect(page.locator(".item-count")).toContainText("3");
  for (const syntheticNode of nodes) {
    await expect(
      page.locator(`.react-flow__node[data-id="${syntheticNode.id}"]`),
    ).toBeVisible();
  }
});

test("outgoing reference remove circles delete one undoable reference", async ({
  page,
}) => {
  const source = {
    id: syntheticId(31),
    name: "Reference source",
    x: 100,
    y: 100,
  };
  const firstTarget = {
    id: syntheticId(32),
    name: "First target",
    x: 520,
    y: 70,
  };
  const secondTarget = {
    id: syntheticId(33),
    name: "Second target",
    x: 520,
    y: 260,
  };
  await openSyntheticWorkspace(page, [source, firstTarget, secondTarget], [
    { sourceNodeId: source.id, targetNodeId: firstTarget.id },
    { sourceNodeId: source.id, targetNodeId: secondTarget.id },
  ]);

  const sourceNode = node(page, source.id);
  const removeButtons = sourceNode.locator(".graph-node-reference-remove");
  await expect(removeButtons).toHaveCount(2);
  await expect(
    sourceNode.getByRole("button", { name: "Remove reference: First target" }),
  ).toHaveCSS("border-radius", "50%");

  await sourceNode
    .getByRole("button", { name: "Remove reference: First target" })
    .click();
  await expect(removeButtons).toHaveCount(1);
  await expect
    .poll(async () => (await storedWorkspace(page))?.references)
    .toEqual([
      { sourceNodeId: source.id, targetNodeId: secondTarget.id },
    ]);

  await page.keyboard.press("Control+z");
  await expect(removeButtons).toHaveCount(2);
  await expect
    .poll(async () => (await storedWorkspace(page))?.references)
    .toEqual([
      { sourceNodeId: source.id, targetNodeId: firstTarget.id },
      { sourceNodeId: source.id, targetNodeId: secondTarget.id },
    ]);
});

test("removing a reference commits the canvas active edit as a separate undo step", async ({
  page,
}) => {
  const editingNode = {
    content: "Original content",
    id: syntheticId(34),
    name: "Editing node",
    x: 100,
    y: 100,
  };
  const spatialNeighbor = {
    id: syntheticId(37),
    name: "Spatial neighbor",
    x: 100,
    y: 230,
  };
  const referenceSource = {
    id: syntheticId(35),
    name: "Reference source",
    x: 520,
    y: 100,
  };
  const target = {
    id: syntheticId(36),
    name: "Reference target",
    x: 900,
    y: 100,
  };
  await openSyntheticWorkspace(
    page,
    [editingNode, spatialNeighbor, referenceSource, target],
    [{ sourceNodeId: referenceSource.id, targetNodeId: target.id }],
  );

  const editingNodeCard = node(page, editingNode.id);
  const editedContent = Array.from(
    { length: 14 },
    (_, index) => `Synthetic line ${index + 1} expands automatic height`,
  ).join("\n");
  await editingNodeCard.dblclick({ position: { x: 80, y: 24 } });
  await editingNodeCard.locator("textarea").fill(editedContent);
  await node(page, referenceSource.id)
    .getByRole("button", { name: "Remove reference: Reference target" })
    .click();

  await expect(editingNodeCard).toHaveAttribute("data-editing", "false");
  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      return {
        content: stored?.nodes?.find(
          (candidate: { id?: string }) => candidate.id === editingNode.id,
        )?.content,
        references: stored?.references,
      };
    })
    .toEqual({ content: editedContent, references: [] });
  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      return stored?.layout?.find(
        (item: { nodeId: string }) => item.nodeId === spatialNeighbor.id,
      );
    })
    .not.toMatchObject({ x: spatialNeighbor.x, y: spatialNeighbor.y });

  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      return {
        content: stored?.nodes?.find(
          (candidate: { id?: string }) => candidate.id === editingNode.id,
        )?.content,
        references: stored?.references,
      };
    })
    .toEqual({
      content: editedContent,
      references: [
        { sourceNodeId: referenceSource.id, targetNodeId: target.id },
      ],
    });
  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      return stored?.layout?.find(
        (item: { nodeId: string }) => item.nodeId === spatialNeighbor.id,
      );
    })
    .not.toMatchObject({ x: spatialNeighbor.x, y: spatialNeighbor.y });

  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      return {
        content: stored?.nodes?.find(
          (candidate: { id?: string }) => candidate.id === editingNode.id,
        )?.content,
        neighbor: stored?.layout?.find(
          (item: { nodeId: string }) => item.nodeId === spatialNeighbor.id,
        ),
      };
    })
    .toEqual({
      content: editedContent,
      neighbor: expect.objectContaining({
        x: spatialNeighbor.x,
        y: spatialNeighbor.y,
      }),
    });

  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      return stored?.nodes?.find(
        (candidate: { id?: string }) => candidate.id === editingNode.id,
      )?.content;
    })
    .toBe("Original content");
});

test("an invalid editor draft blocks reference removal without losing the draft", async ({
  page,
}) => {
  const editingNode = {
    id: syntheticId(38),
    name: "Editable node",
    x: 100,
    y: 100,
  };
  const referenceSource = {
    id: syntheticId(39),
    name: "Existing name",
    x: 520,
    y: 100,
  };
  const target = {
    id: syntheticId(40),
    name: "Reference target",
    x: 900,
    y: 100,
  };
  await openSyntheticWorkspace(page, [editingNode, referenceSource, target], [
    { sourceNodeId: referenceSource.id, targetNodeId: target.id },
  ]);

  const editor = node(page, editingNode.id);
  await editor.dblclick({ position: { x: 80, y: 24 } });
  await editor.locator("input").fill(referenceSource.name);
  await expect(editor.getByRole("alert")).toHaveText("This name already exists");

  const remove = node(page, referenceSource.id).getByRole("button", {
    name: "Remove reference: Reference target",
  });
  await expect(remove).toBeDisabled();
  await expect
    .poll(async () => (await storedWorkspace(page))?.references)
    .toEqual([
      { sourceNodeId: referenceSource.id, targetNodeId: target.id },
    ]);
  await expect(editor).toHaveAttribute("data-editing", "true");
  await expect(editor.locator("input")).toHaveValue(referenceSource.name);
});

test("multiple canvases share nodes while keeping placements independent", async ({
  page,
}) => {
  const [syntheticNode] = gridNodes(1, 1);
  await openSyntheticWorkspace(page, [syntheticNode]);
  const canvasSelect = page.getByTestId("canvas-select");
  const firstCanvasId = await canvasSelect.inputValue();

  await page.getByTestId("canvas-create").click();
  await expect(canvasSelect.locator("option")).toHaveCount(2);
  const secondCanvasId = await canvasSelect.inputValue();
  expect(secondCanvasId).not.toBe(firstCanvasId);
  await expect(node(page, syntheticNode.id)).toHaveCount(0);

  await canvasSelect.selectOption(firstCanvasId);
  await expect(node(page, syntheticNode.id)).toBeVisible();
  await canvasSelect.selectOption(secondCanvasId);
  await expect(node(page, syntheticNode.id)).toHaveCount(0);

  await page.getByTestId("nodes-navigation").click();
  await page.getByTestId("node-list-row").click();
  await expect(node(page, syntheticNode.id)).toBeVisible();
  await page.locator(".react-flow__pane").click({ position: { x: 700, y: 500 } });
  await node(page, syntheticNode.id).click();
  await page.keyboard.press("Delete");
  await page.locator(".confirmation-dialog .danger-button").click();
  await expect(node(page, syntheticNode.id)).toHaveCount(0);

  await page.getByTestId("canvas-delete").click();
  await page.getByTestId("workspace-deletion-confirm").click();
  await expect(canvasSelect.locator("option")).toHaveCount(1);
  await expect(node(page, syntheticNode.id)).toBeVisible();

  await page.getByTestId("nodes-navigation").click();
  await page.getByTestId("node-delete-permanently").click();
  await page.getByTestId("workspace-deletion-confirm").click();
  await expect(page.getByTestId("node-list-row")).toHaveCount(0);
  await expect.poll(async () => (await storedWorkspace(page))?.nodes).toEqual([]);
});

test("document import requires and records an explicit canvas position", async ({
  page,
}) => {
  const nodes = gridNodes(1, 1);
  await openSyntheticWorkspace(page, nodes);

  await page.getByTestId("document-import-open").click();
  await expect(
    page.getByTestId("document-import-placement-status"),
  ).toHaveAttribute("data-selected", "false");
  await page.getByTestId("document-import-choose-placement").click();
  await expect(page.getByTestId("canvas-point-selection")).toBeVisible();
  await expect(page.getByTestId("graph-canvas")).toHaveAttribute(
    "data-point-selection",
    "true",
  );

  await page.getByTestId("graph-canvas").click({
    position: { x: 760, y: 520 },
  });

  await expect(
    page.getByTestId("document-import-placement-status"),
  ).toHaveAttribute("data-selected", "true");
  await expect(
    page.getByTestId("document-import-placement-status"),
  ).toContainText(/760.*520/u);
});

test("canvas select all, remove, undo, redo and context menu share one keyboard model", async ({
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
  const undo = page.getByRole("button", { name: "Undo" });
  await expect(undo).toBeEnabled();
  await undo.click();
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
  await expect(guide.locator(".canvas-operation-picker-item")).toHaveCount(13);

  const animatedTargets: Record<string, string> = {
    pan: ".canvas-operation-scene",
    zoom: ".canvas-operation-scene",
    frame: ".canvas-operation-scene",
    select: ".canvas-operation-marquee",
    selectAll: ".canvas-operation-node-a",
    edit: ".canvas-operation-editor",
    resize: ".canvas-operation-node-a",
    arrange: ".canvas-operation-node-b",
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
  await expect(guide.locator(".canvas-operation-picker-item")).toHaveCount(13);
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

test("preserved extension metadata can be cleared separately and undone", async ({
  page,
}) => {
  const nodes = gridNodes(1, 1);
  await openSyntheticWorkspace(
    page,
    nodes,
    [],
    { x: 0, y: 0, zoom: 1 },
    {
      "dev.example.preview": {
        schemaVersion: 1,
        workspace: { theme: "dark" },
        byNodeId: { [nodes[0].id]: { collapsed: true } },
      },
    },
  );

  await page.getByTestId("settings-navigation").click();
  await page.getByTestId("settings-tab-extensions").click();
  await expect(page.getByText("dev.example.preview", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear metadata" }).click();
  await page
    .getByRole("button", { name: "Click again to confirm clearing" })
    .click();
  await expect
    .poll(async () => (await storedWorkspace(page))?.view?.extensionMetadata)
    .toEqual({});

  await page.getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(async () => (await storedWorkspace(page))?.view?.extensionMetadata)
    .toEqual({
      "dev.example.preview": {
        schemaVersion: 1,
        workspace: { theme: "dark" },
        byNodeId: { [nodes[0].id]: { collapsed: true } },
      },
    });
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

test("workspace replacement preview can inspect every canvas", async ({ page }) => {
  const mainCanvasId = "10000000-0000-4000-8000-000000000001";
  const secondCanvasId = "20000000-0000-4000-8000-000000000002";
  const currentMain = { id: syntheticId(911), name: "Current main", x: 100, y: 100 };
  const currentSecond = {
    id: syntheticId(912),
    name: "Current second",
    x: 200,
    y: 200,
  };
  const recoveryMain = {
    id: syntheticId(913),
    name: "Recovery main",
    x: 300,
    y: 300,
  };
  const recoverySecond = {
    id: syntheticId(914),
    name: "Recovery second",
    x: 400,
    y: 400,
  };
  const recoveryUnplaced = {
    id: syntheticId(915),
    name: "Recovery unplaced",
  };
  const snapshot = (
    activeCanvasId: string,
    mainNode: SyntheticNode,
    secondNode: SyntheticNode,
  ) => ({
    version: 4,
    nodes: [mainNode, secondNode].map((item) => ({
      id: item.id,
      name: item.name,
      content: null,
    })),
    references: [],
    view: {
      activeCanvasId,
      canvases: [
        {
          id: mainCanvasId,
          name: "Main",
          layout: [{ nodeId: mainNode.id, x: mainNode.x, y: mainNode.y }],
          viewport: null,
        },
        {
          id: secondCanvasId,
          name: "Second",
          layout: [
            { nodeId: secondNode.id, x: secondNode.x, y: secondNode.y },
          ],
          viewport: null,
        },
      ],
      contentProcessorByNodeId: {},
      extensionMetadata: {},
    },
  });
  const recoverySnapshot = snapshot(
    secondCanvasId,
    recoveryMain,
    recoverySecond,
  );
  recoverySnapshot.nodes.push({
    id: recoveryUnplaced.id,
    name: recoveryUnplaced.name,
    content: null,
  });
  await page.addInitScript(
    ({ primaryKey, primary, recoveryKey, recovery }) => {
      localStorage.clear();
      localStorage.setItem(primaryKey, JSON.stringify(primary));
      localStorage.setItem(recoveryKey, JSON.stringify(recovery));
    },
    {
      primaryKey: workspaceStorageKey,
      primary: snapshot(mainCanvasId, currentMain, currentSecond),
      recoveryKey: workspaceRecoveryStorageKey,
      recovery: recoverySnapshot,
    },
  );
  await page.goto("/");
  await page.getByTestId("settings-navigation").click();
  await page.getByTestId("settings-tab-dataSecurity").click();
  await page.getByTestId("restore-recovery-workspace").click();

  const previewCanvas = page.getByTestId("workspace-restore-canvas-select");
  await expect(previewCanvas.locator("option")).toHaveCount(3);
  await expect(previewCanvas).toHaveValue(secondCanvasId);
  await expect(page.getByText(recoverySecond.name, { exact: true })).toBeVisible();
  await previewCanvas.selectOption(mainCanvasId);
  await expect(page.getByText(recoveryMain.name, { exact: true })).toBeVisible();
  await previewCanvas.selectOption("__unplaced__");
  await expect(page.getByText(recoveryUnplaced.name, { exact: true })).toBeVisible();
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

test("automatic, fitted and manually resized node dimensions persist and reset", async ({
  page,
}) => {
  const targetNode: SyntheticNode = {
    content: Array.from(
      { length: 28 },
      (_, index) => `Synthetic detail line ${index + 1} with wrapped content`,
    ).join("\n"),
    id: syntheticId(1),
    name: "Resizable synthetic node with a deliberately long title",
    x: 100,
    y: 100,
  };
  const referenceTarget: SyntheticNode = {
    id: syntheticId(2),
    name: "Resize reference target",
    x: 1_200,
    y: 160,
  };
  await openSyntheticWorkspace(page, [targetNode, referenceTarget], [
    { sourceNodeId: targetNode.id, targetNodeId: referenceTarget.id },
  ]);
  let target = node(page, targetNode.id);
  const referencePath = page.locator(".graph-reference-path").first();
  await expect(referencePath).toHaveAttribute("d", /^M/u);
  const automaticBounds = await target.boundingBox();
  expect(automaticBounds).not.toBeNull();
  expect(automaticBounds!.width).toBeGreaterThanOrEqual(270);
  expect(automaticBounds!.width).toBeLessThanOrEqual(481);
  expect(automaticBounds!.height).toBeLessThanOrEqual(361);
  await expect(target.locator(".graph-node-fit-button")).toBeVisible();

  await target.locator(".graph-node-fit-button").click();
  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      const item = stored?.layout?.find(
        (candidate: { nodeId: string }) => candidate.nodeId === targetNode.id,
      );
      return item?.width === undefined || item?.height === undefined
        ? null
        : { height: item.height, width: item.width };
    })
    .not.toBeNull();
  const fittedItem = (await storedWorkspace(page))?.layout?.find(
    (candidate: { nodeId: string }) => candidate.nodeId === targetNode.id,
  );
  expect(fittedItem?.width).toEqual(expect.any(Number));

  await target.click({ position: { x: 30, y: 20 } });
  const resizeHandle = target.locator(
    ".graph-node-resize-handle.bottom.right",
  );
  await expect(resizeHandle).toBeVisible();
  const beforeResize = await target.boundingBox();
  const beforeResizePath = await referencePath.getAttribute("d");
  const handleBounds = await resizeHandle.boundingBox();
  expect(beforeResize).not.toBeNull();
  expect(handleBounds).not.toBeNull();
  await page.mouse.move(
    handleBounds!.x + handleBounds!.width / 2,
    handleBounds!.y + handleBounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handleBounds!.x + handleBounds!.width / 2 + 120,
    handleBounds!.y + handleBounds!.height / 2 + 80,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      const item = stored?.layout?.find(
        (candidate: { nodeId: string }) => candidate.nodeId === targetNode.id,
      );
      return item?.width ?? 0;
    })
    .toBeGreaterThan(beforeResize!.width + 100);
  const resizedItem = (await storedWorkspace(page))?.layout?.find(
    (candidate: { nodeId: string }) => candidate.nodeId === targetNode.id,
  );
  expect(resizedItem?.width).toEqual(expect.any(Number));
  await expect.poll(() => referencePath.getAttribute("d")).not.toBe(
    beforeResizePath,
  );
  const resizedPath = await referencePath.getAttribute("d");

  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      return stored?.layout?.find(
        (candidate: { nodeId: string }) => candidate.nodeId === targetNode.id,
      )?.width;
    })
    .toBe(fittedItem!.width);
  await page.keyboard.press("Control+y");
  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      return stored?.layout?.find(
        (candidate: { nodeId: string }) => candidate.nodeId === targetNode.id,
      )?.width;
    })
    .toBe(resizedItem!.width);

  await page.reload();
  target = node(page, targetNode.id);
  await expect
    .poll(async () => (await target.boundingBox())?.width ?? 0)
    .toBeGreaterThan(beforeResize!.width + 100);
  await expect(referencePath).toHaveAttribute("d", resizedPath!);

  await target.click({ button: "right", position: { x: 30, y: 20 } });
  await page.getByRole("button", { name: "Reset size" }).click();
  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      const item = stored?.layout?.find(
        (candidate: { nodeId: string }) => candidate.nodeId === targetNode.id,
      );
      return item !== undefined && !("width" in item) && !("height" in item);
    })
    .toBe(true);
  await expect(target.locator(".graph-node-fit-button")).toBeVisible();
});

test("finishing an automatic size change pushes only overlapping neighbors", async ({
  page,
}) => {
  const growingNode: SyntheticNode = {
    content: "short",
    id: syntheticId(1),
    name: "Growing node",
    x: 100,
    y: 100,
  };
  const neighbor: SyntheticNode = {
    id: syntheticId(2),
    name: "Spatial neighbor",
    x: 100,
    y: 230,
  };
  const unrelated: SyntheticNode = {
    id: syntheticId(3),
    name: "Unrelated node",
    x: 1_200,
    y: 100,
  };
  await openSyntheticWorkspace(page, [growingNode, neighbor, unrelated]);
  await node(page, growingNode.id).dblclick({ position: { x: 80, y: 24 } });
  const editor = page.locator('[data-node-id][data-editing="true"]');
  await editor.locator("textarea").fill(
    Array.from(
      { length: 14 },
      (_, index) => `Synthetic line ${index + 1} expands automatic height`,
    ).join("\n"),
  );
  await editor.locator("textarea").press("Escape");

  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      return stored?.layout?.find(
        (item: { nodeId: string }) => item.nodeId === neighbor.id,
      );
    })
    .not.toMatchObject({ x: neighbor.x, y: neighbor.y });
  const changed = await storedWorkspace(page);
  expect(
    changed.layout.find(
      (item: { nodeId: string }) => item.nodeId === growingNode.id,
    ),
  ).toMatchObject({ x: growingNode.x, y: growingNode.y });
  expect(
    changed.layout.find(
      (item: { nodeId: string }) => item.nodeId === unrelated.id,
    ),
  ).toMatchObject({ x: unrelated.x, y: unrelated.y });
});

test("smart arrangement normalizes width and saves one undoable layout step", async ({
  page,
}) => {
  const arrangedNodes = gridNodes(3, 1).map((item, index) => ({
    ...item,
    content: `Synthetic arrangement content ${"x".repeat(index === 2 ? 2_000 : index * 30)}`,
  }));
  const originalLayout = arrangedNodes.map(({ id, x, y }) => ({ nodeId: id, x, y }));
  await openSyntheticWorkspace(page, arrangedNodes, [
    { sourceNodeId: arrangedNodes[0].id, targetNodeId: arrangedNodes[1].id },
    { sourceNodeId: arrangedNodes[1].id, targetNodeId: arrangedNodes[2].id },
  ]);
  await page.keyboard.press("Control+a");
  await node(page, arrangedNodes[1].id).click({
    button: "right",
    position: { x: 24, y: 24 },
  });
  await page.getByTestId("arrange-nodes-context-action").click();
  const dialog = page.getByTestId("smart-arrangement-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("select").nth(0)).toHaveValue("auto");
  await expect(dialog.locator("select").nth(1)).toHaveValue("equal-width");
  await dialog.getByRole("button", { name: "Apply arrangement" }).click();

  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      return stored?.layout?.every(
        (item: { height?: number; width?: number }) =>
          typeof item.width === "number" && item.height === undefined,
      );
    })
    .toBe(true);
  const arranged = await storedWorkspace(page);
  const widths = new Set(
    arranged.layout.map((item: { width: number }) => item.width),
  );
  expect(widths.size).toBe(1);
  await expect(
    node(page, arrangedNodes[2].id).locator(".graph-node-fit-button"),
  ).toBeVisible();
  const xByNodeId = new Map(
    arranged.layout.map((item: { nodeId: string; x: number }) => [item.nodeId, item.x]),
  );
  expect(xByNodeId.get(arrangedNodes[0].id)).toBeLessThan(
    xByNodeId.get(arrangedNodes[1].id),
  );
  expect(xByNodeId.get(arrangedNodes[1].id)).toBeLessThan(
    xByNodeId.get(arrangedNodes[2].id),
  );

  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => {
      const stored = await storedWorkspace(page);
      return originalLayout.every((original) => {
        const restored = stored?.layout?.find(
          (item: { nodeId: string }) => item.nodeId === original.nodeId,
        );
        return (
          restored?.x === original.x &&
          restored?.y === original.y &&
          restored.width === undefined &&
          restored.height === undefined
        );
      });
    })
    .toBe(true);
});

test("automatic overlap avoidance preference persists on this device", async ({
  page,
}) => {
  await openSyntheticWorkspace(page, gridNodes(1, 1));
  await page.getByTestId("settings-navigation").click();
  await page.getByTestId("settings-tab-operations").click();
  const preference = page.getByTestId("auto-avoid-canvas-overlaps");
  await expect(preference).toBeChecked();
  await preference.uncheck();
  await page.reload();
  await page.getByTestId("settings-navigation").click();
  await page.getByTestId("settings-tab-operations").click();
  await expect(page.getByTestId("auto-avoid-canvas-overlaps")).not.toBeChecked();
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

test("multi-selected nodes enter the smart-reference queue as one batch", async ({
  page,
}) => {
  const nodes = gridNodes(3, 1);
  await openSyntheticWorkspace(page, nodes);

  await node(page, nodes[0].id).click({ position: { x: 24, y: 24 } });
  await node(page, nodes[1].id).click({
    modifiers: ["Shift"],
    position: { x: 24, y: 24 },
  });
  await node(page, nodes[1].id).click({
    button: "right",
    position: { x: 24, y: 24 },
  });
  const batchAction = page.getByTestId("smart-reference-context-action");
  await expect(batchAction).toBeVisible();
  await expect(batchAction).toHaveAttribute("data-node-count", "2");
  await batchAction.click();

  const queue = page.getByTestId("smart-reference-queue");
  await expect(queue).toBeVisible();
  await expect(queue.locator(".smart-reference-queue-item")).toHaveCount(2);
  await expect(queue.locator('[data-status="failed"]')).toHaveCount(2);
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
});

test("a long smart-reference queue owns a real scroll viewport", async ({ page }) => {
  const nodes = gridNodes(7, 2);
  await openSyntheticWorkspace(page, nodes);
  const canvas = page.getByTestId("graph-canvas");

  await canvas.click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Control+a");
  await node(page, nodes[0].id).click({
    button: "right",
    position: { x: 24, y: 24 },
  });
  await page.getByTestId("smart-reference-context-action").click();

  const queueList = page.locator(".smart-reference-queue-list");
  await expect(queueList.locator(".smart-reference-queue-item")).toHaveCount(
    nodes.length,
  );
  await expect
    .poll(() =>
      queueList.evaluate((element) => ({
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
        scrollHeight: element.scrollHeight,
      })),
    )
    .toMatchObject({ overflowY: "auto" });
  const dimensions = await queueList.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  await queueList.locator(".smart-reference-queue-item").last().scrollIntoViewIfNeeded();
  await expect(queueList.locator(".smart-reference-queue-item").last()).toBeVisible();
});

test("the low-glare starry theme is selectable and persists on this device", async ({
  page,
}) => {
  const themedNodes = gridNodes(1, 1);
  themedNodes[0].content =
    "[[li:totp]]JBSWY3DPEHPK3PXP[[/li]] [[li:secret]]synthetic-secret[[/li]]";
  await openSyntheticWorkspace(page, themedNodes);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "starry-dark");
  await expect(page.getByTestId("graph-canvas")).toHaveAttribute(
    "data-theme",
    "starry-dark",
  );
  await expect(page.locator(".totp-content-line")).toHaveCSS(
    "background-color",
    "rgb(17, 26, 45)",
  );
  await expect(page.locator(".secret-content")).toHaveCSS(
    "background-color",
    "rgb(17, 26, 45)",
  );

  await page.getByRole("button", { name: "Import document" }).click();
  const importDialog = page.locator(".document-import-dialog");
  await expect(importDialog).toHaveCSS("background-color", "rgb(16, 25, 43)");
  await expect(importDialog.locator("input").first()).toHaveCSS(
    "background-color",
    "rgb(11, 18, 33)",
  );
  await importDialog.getByRole("button", { name: "Close" }).click();

  await page.getByTestId("settings-navigation").click();
  const settingsTabs = page.locator(".settings-tab-list .settings-tab");
  await expect(settingsTabs).toHaveCount(5);
  await expect
    .poll(() =>
      page.locator(".settings-tab-list").evaluate((element) =>
        getComputedStyle(element).gridTemplateColumns.split(" ").length,
      ),
    )
    .toBe(5);
  await page.getByTestId("settings-tab-smartReference").click();
  const smartReferencePanel = page.locator("#settings-panel-smartReference");
  await smartReferencePanel
    .locator(".smart-reference-settings .segmented-control")
    .first()
    .getByRole("button", { name: "Remote" })
    .click();
  await expect(
    smartReferencePanel.locator(".remote-embedding-fields input").first(),
  ).toHaveCSS("background-color", "rgb(11, 18, 33)");

  await page.getByTestId("settings-tab-dataSecurity").click();
  expect(
    await page.evaluate(() => {
      const setting = document.createElement("label");
      setting.className = "security-idle-setting";
      document.querySelector(".app-shell")?.append(setting);
      const backgroundColor = getComputedStyle(setting).backgroundColor;
      setting.remove();
      return backgroundColor;
    }),
  ).toBe("rgb(11, 18, 33)");
  expect(
    await page.evaluate(() => {
      const gate = document.createElement("div");
      gate.className = "security-gate";
      gate.innerHTML = `
        <form class="security-unlock-form"><label>Master password</label></form>
        <p class="security-error">Unlock failed</p>
        <div class="security-unlock-divider">or</div>
        <div class="security-system-unlock"><small>System unlock help</small></div>
      `;
      document.body.append(gate);
      const colors = {
        error: getComputedStyle(gate.querySelector(".security-error")!).color,
        helper: getComputedStyle(
          gate.querySelector(".security-system-unlock small")!,
        ).color,
        label: getComputedStyle(gate.querySelector("label")!).color,
      };
      gate.remove();
      return colors;
    }),
  ).toEqual({
    error: "rgb(255, 170, 165)",
    helper: "rgb(154, 169, 189)",
    label: "rgb(201, 213, 231)",
  });
  expect(
    await page.evaluate(() => {
      const fixture = document.createElement("div");
      fixture.innerHTML = `
        <div class="smart-reference-progress"><span>Downloading</span></div>
        <div class="smart-reference-status">Analysis failed</div>
        <div class="extension-presentation-select"><span>Indent</span><select></select></div>
      `;
      document.querySelector(".app-shell")?.append(fixture);
      const colors = {
        extension: getComputedStyle(
          fixture.querySelector(".extension-presentation-select")!,
        ).backgroundColor,
        progress: getComputedStyle(
          fixture.querySelector(".smart-reference-progress")!,
        ).backgroundColor,
        status: getComputedStyle(
          fixture.querySelector(".smart-reference-status")!,
        ).backgroundColor,
      };
      fixture.remove();
      return colors;
    }),
  ).toEqual({
    extension: "rgb(17, 26, 45)",
    progress: "rgb(20, 35, 60)",
    status: "rgb(50, 26, 40)",
  });

  await page.getByTestId("settings-tab-general").click();
  const starry = page.getByTestId("appearance-theme-starry-dark");
  const mint = page.getByTestId("appearance-theme-mint-light");
  await expect(starry).toHaveAttribute("aria-pressed", "true");
  await mint.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "mint-light");
  await expect(mint).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "mint-light");
  await page.getByTestId("settings-navigation").click();
  await expect(page.getByTestId("appearance-theme-mint-light")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
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
  await expect
    .poll(async () => (await storedWorkspace(page))?.viewport?.y)
    .toBeLessThan(0);
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

test("low-zoom Shift marquee follows the pointer and selects a partially intersected node", async ({
  page,
}) => {
  const nodes = gridNodes(3, 1);
  await openSyntheticWorkspace(page, nodes, [], { x: 40, y: 30, zoom: 0.11 });
  const target = node(page, nodes[0].id);
  const targetBox = await target.boundingBox();
  expect(targetBox).not.toBeNull();
  if (targetBox === null) {
    return;
  }
  const start = { x: targetBox.x - 24, y: targetBox.y - 24 };
  const end = {
    x: targetBox.x + targetBox.width * 0.7,
    y: targetBox.y + targetBox.height + 24,
  };

  await page.keyboard.down("Shift");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });

  const marqueeBox = await page
    .getByTestId("canvas-selection-marquee")
    .boundingBox();
  expect(marqueeBox).not.toBeNull();
  expect(marqueeBox!.x).toBeCloseTo(start.x, 0);
  expect(marqueeBox!.y).toBeCloseTo(start.y, 0);
  expect(marqueeBox!.width).toBeCloseTo(end.x - start.x, 0);
  expect(marqueeBox!.height).toBeCloseTo(end.y - start.y, 0);

  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(target).toHaveAttribute("data-selected", "true");
  await expect(node(page, nodes[1].id)).toHaveAttribute("data-selected", "false");
});

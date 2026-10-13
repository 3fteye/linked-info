// Test-only, bounded metadata. Never retain request URLs, bodies or error text.
const buckets = ["document", "entry", "workspace", "app", "canvas", "dependency", "source", "style", "other"];
const markers = ["rootPopulated", "securityGate", "storageGate", "storageError", "appShell", "canvas", "flowReady"];
const bounded = (value) => Number.isFinite(value) ? Math.min(600_000, Math.max(0, Math.round(value))) : null;

export function resourceBucket(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return "other"; }
  if (url.origin !== "http://127.0.0.1:1423") return "other";
  const exact = { "/": "document", "/src/main.tsx": "entry", "/src/MainWorkspace.tsx": "workspace",
    "/src/App.tsx": "app", "/src/GraphCanvas.tsx": "canvas" };
  if (Object.hasOwn(exact, url.pathname)) return exact[url.pathname];
  if (url.pathname.endsWith(".css")) return "style";
  if (url.pathname.startsWith("/node_modules/")) return "dependency";
  if (url.pathname.startsWith("/src/")) return "source";
  return "other";
}

export function sanitizeDom(value) {
  const result = { available: value?.available === true, sampledAtMs: bounded(value?.sampledAtMs),
    rootHasChildren: value?.rootHasChildren === true, firstSeenMs: {} };
  for (const marker of markers) result.firstSeenMs[marker] = bounded(value?.firstSeenMs?.[marker]);
  return result;
}

export function validateStartupDiagnostic(value) {
  const numeric = (v) => Number.isInteger(v) && v >= 0 && v <= 600_000;
  const nullable = (v) => v === null || numeric(v);
  const keys = (v, expected) => v !== null && typeof v === "object" &&
    JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...expected].sort());
  const valid = keys(value, ["schemaVersion", "elapsedMs", "pageErrors", "consoleErrors", "dropped", "resources", "dom"]) &&
    value.schemaVersion === 1 && numeric(value.elapsedMs) &&
    [value.pageErrors, value.consoleErrors, value.dropped].every(numeric) &&
    keys(value.resources, buckets) && buckets.every((bucket) => {
      const row = value.resources[bucket];
      return keys(row, ["started", "finished", "failed", "httpErrors", "pending", "firstStartMs", "maxDurationMs"]) &&
        [row.started, row.finished, row.failed, row.httpErrors, row.pending, row.maxDurationMs].every(numeric) &&
        row.started === row.finished + row.failed + row.pending && nullable(row.firstStartMs);
    }) && keys(value.dom, ["available", "sampledAtMs", "rootHasChildren", "firstSeenMs"]) &&
    typeof value.dom.available === "boolean" && typeof value.dom.rootHasChildren === "boolean" &&
    nullable(value.dom.sampledAtMs) && keys(value.dom.firstSeenMs, markers) &&
    markers.every((marker) => nullable(value.dom.firstSeenMs[marker]));
  if (!valid) throw new Error("Invalid startup diagnostic schema");
  return value;
}

export function observeStartupDom() {
  const seen = {};
  const selectors = { securityGate: ".security-gate", storageGate: ".storage-problem-shell",
    storageError: "#storage-problem-title, #storage-recovery-title", appShell: ".app-shell",
    canvas: '[data-testid="graph-canvas"]', flowReady: '[data-testid="graph-canvas"][data-flow-ready="true"]' };
  const sample = () => {
    const now = Math.round(performance.now());
    if (document.querySelector("#root")?.childElementCount > 0) seen.rootPopulated ??= now;
    for (const [key, selector] of Object.entries(selectors)) {
      if (document.querySelector(selector)) seen[key] ??= now;
    }
    if (seen.flowReady !== undefined) observer.disconnect();
  };
  const observer = new MutationObserver(sample);
  observer.observe(document, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["data-flow-ready"] });
  window.__liStartupDiagnostic = () => {
    sample(); observer.disconnect();
    return { available: true, sampledAtMs: performance.now(),
      rootHasChildren: document.querySelector("#root")?.childElementCount > 0, firstSeenMs: seen };
  };
  sample();
}

export async function installStartupDiagnostics(page, now = () => performance.now()) {
  const started = now();
  const active = new Map();
  const resources = Object.fromEntries(buckets.map((key) => [key, {
    started: 0, finished: 0, failed: 0, httpErrors: 0, pending: 0, firstStartMs: null, maxDurationMs: 0,
  }]));
  let pageErrors = 0;
  let consoleErrors = 0;
  let dropped = 0;
  let accepted = 0;
  const onRequest = (request) => {
    if (accepted >= 4096) { dropped = Math.min(dropped + 1, 4096); return; }
    accepted += 1;
    const bucket = resourceBucket(request.url());
    active.set(request, { bucket, time: now() });
    const stats = resources[bucket];
    stats.started += 1; stats.pending += 1;
    stats.firstStartMs ??= bounded(now() - started);
  };
  const settle = (request, failed) => {
    const entry = active.get(request);
    if (entry === undefined) return;
    active.delete(request);
    const stats = resources[entry.bucket];
    stats.pending -= 1; stats[failed ? "failed" : "finished"] += 1;
    stats.maxDurationMs = Math.max(stats.maxDurationMs, bounded(now() - entry.time) ?? 0);
  };
  const handlers = {
    request: onRequest,
    requestfinished: (request) => settle(request, false),
    requestfailed: (request) => settle(request, true),
    response: (response) => {
      const entry = active.get(response.request());
      if (entry && response.status() >= 400) resources[entry.bucket].httpErrors += 1;
    },
    pageerror: () => { pageErrors = Math.min(pageErrors + 1, 4096); },
    console: (message) => { if (message.type() === "error") consoleErrors = Math.min(consoleErrors + 1, 4096); },
  };
  for (const [name, handler] of Object.entries(handlers)) page.on(name, handler);
  await page.addInitScript(observeStartupDom);
  return async () => {
    // Detach before further arrangement actions so the result describes startup only.
    for (const [name, handler] of Object.entries(handlers)) page.off(name, handler);
    for (const { bucket, time } of active.values()) {
      resources[bucket].maxDurationMs = Math.max(resources[bucket].maxDurationMs, bounded(now() - time) ?? 0);
    }
    active.clear();
    const dom = await page.evaluate(() => window.__liStartupDiagnostic?.()).catch(() => null);
    return { schemaVersion: 1, elapsedMs: bounded(now() - started), pageErrors, consoleErrors,
      dropped, resources, dom: sanitizeDom(dom) };
  };
}

export function validateArrangementDiagnostic(value) {
  const expected = ["schemaVersion", "elapsedMs", "workerCount", "dropped", "createdMs", "handlerReadyMs",
    "closedMs", "probeFailed", "domAvailable", "dialogPresent", "applyDisabled", "dialogErrorPresent"];
  const numeric = (v) => Number.isInteger(v) && v >= 0 && v <= 600_000;
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected.sort()) ||
    value.schemaVersion !== 1 || !numeric(value.elapsedMs) ||
    !Number.isInteger(value.workerCount) || value.workerCount < 0 || value.workerCount > 4 ||
    !Number.isInteger(value.dropped) || value.dropped < 0 || value.dropped > 4096 ||
    ![value.createdMs, value.handlerReadyMs, value.closedMs].every((v) => v === null || numeric(v)) ||
    ![value.probeFailed, value.domAvailable, value.dialogPresent, value.applyDisabled,
      value.dialogErrorPresent].every((v) => typeof v === "boolean")) {
    throw new Error("Invalid arrangement diagnostic schema");
  }
  return value;
}

export async function installArrangementDiagnostics(page, now = () => performance.now()) {
  const start = now();
  let stopped = false;
  const listeners = [];
  const result = { schemaVersion: 1, elapsedMs: 0, workerCount: 0, dropped: 0,
    createdMs: null, handlerReadyMs: null, closedMs: null, probeFailed: false,
    domAvailable: false, dialogPresent: false, applyDisabled: false, dialogErrorPresent: false };
  const onWorker = (worker) => {
    let url;
    try { url = new URL(worker.url()); } catch { return; }
    if (url.origin !== "http://127.0.0.1:1423" || url.pathname !== "/src/canvasAutoLayout.worker.ts") return;
    if (result.workerCount >= 4) { result.dropped = Math.min(result.dropped + 1, 4096); return; }
    result.workerCount += 1;
    result.createdMs ??= bounded(now() - start);
    const onClose = () => { if (!stopped) result.closedMs ??= bounded(now() - start); };
    worker.on("close", onClose);
    listeners.push([worker, onClose]);
    // Observe only handler installation, never messages or input/output data.
    // No replacement of Worker/postMessage/terminate and no synthetic replies.
    void worker.evaluate(() => new Promise((resolve) => {
      const deadline = performance.now() + 15_000;
      const check = () => {
        if (typeof self.onmessage === "function") resolve(true);
        else if (performance.now() >= deadline) resolve(false);
        else setTimeout(check, 25);
      };
      check();
    })).then((ready) => {
      if (stopped) return;
      if (ready === true) result.handlerReadyMs ??= bounded(now() - start);
      else result.probeFailed = true;
    }).catch(() => { if (!stopped) result.probeFailed = true; });
  };
  page.on("worker", onWorker);
  return async () => {
    stopped = true;
    page.off("worker", onWorker);
    for (const [worker, onClose] of listeners) worker.off("close", onClose);
    const dom = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="smart-arrangement-dialog"]');
      return { dialogPresent: dialog !== null,
        applyDisabled: dialog?.querySelector("button.primary-button")?.disabled === true,
        dialogErrorPresent: dialog?.querySelector('[role="alert"]') !== null && dialog !== null };
    }).catch(() => null);
    result.domAvailable = dom !== null;
    result.dialogPresent = dom?.dialogPresent === true;
    result.applyDisabled = dom?.applyDisabled === true;
    result.dialogErrorPresent = dom?.dialogErrorPresent === true;
    result.elapsedMs = bounded(now() - start);
    return result;
  };
}

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

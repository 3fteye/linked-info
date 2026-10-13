import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { installStartupDiagnostics, observeStartupDom, resourceBucket, sanitizeDom,
  validateStartupDiagnostic, installArrangementDiagnostics, validateArrangementDiagnostic } from "../apps/desktop/e2e/fixtures/startup-diagnostics.mjs";
import {
  arrangementScratchPrefix, runColdStartValidation, validateColdStartResult, startupDiagnosticsFromReport,
  collectColdStartEvidence, arrangementDiagnosticsFromReport,
} from "./test-arrangement-cold-start.mjs";

test("arrangement observations preserve worker lifecycle without reading payloads", async () => {
  let tick = 0;
  const page = new EventEmitter();
  page.evaluate = async () => ({ dialogPresent: false, applyDisabled: false, dialogErrorPresent: false,
    secret: "not retained" });
  const finish = await installArrangementDiagnostics(page, () => tick);
  const worker = new EventEmitter();
  worker.url = () => "http://127.0.0.1:1423/src/canvasAutoLayout.worker.ts?token=private";
  worker.evaluate = async () => true;
  tick = 10; page.emit("worker", worker);
  await Promise.resolve();
  tick = 15; worker.emit("close");
  tick = 20;
  const result = validateArrangementDiagnostic(await finish());
  assert.equal(result.createdMs, 10);
  assert.equal(result.handlerReadyMs, 10);
  assert.equal(result.closedMs, 15);
  assert.equal(result.workerCount, 1);
  assert.equal(result.dialogPresent, false);
  assert.equal(worker.listenerCount("close"), 0);
  assert.equal(page.listenerCount("worker"), 0);
  assert.ok(!JSON.stringify(result).includes("private"));
  const source = report(true);
  const attempt = source.suites[0].specs[0].tests[0].results[0];
  assert.equal(arrangementDiagnosticsFromReport(source), null);
  assert.throws(() => arrangementDiagnosticsFromReport(source, true));
  attempt.attachments = [{ name: "arrangement-diagnostics", contentType: "application/json",
    body: Buffer.from(JSON.stringify(result)).toString("base64") }];
  assert.deepEqual(arrangementDiagnosticsFromReport(source, true), result);
  assert.throws(() => validateArrangementDiagnostic({ ...result, message: "private" }));
});

test("arrangement probes are bounded, ignore foreign workers and discard late completion", async () => {
  let resolveProbe;
  const page = new EventEmitter();
  page.evaluate = async () => { throw new Error("synthetic private error"); };
  const finish = await installArrangementDiagnostics(page, () => 100);
  const foreign = { url: () => "https://foreign.example/src/canvasAutoLayout.worker.ts" };
  page.emit("worker", foreign);
  const worker = new EventEmitter();
  worker.url = () => "http://127.0.0.1:1423/src/canvasAutoLayout.worker.ts";
  worker.evaluate = () => new Promise((resolve) => { resolveProbe = resolve; });
  for (let i = 0; i < 5; i += 1) page.emit("worker", worker);
  const result = validateArrangementDiagnostic(await finish());
  const before = JSON.stringify(result);
  resolveProbe(true);
  await Promise.resolve();
  assert.equal(JSON.stringify(result), before);
  assert.equal(result.domAvailable, false);
  assert.equal(result.workerCount, 4);
  assert.equal(result.dropped, 1);
});

test("startup resource categorization never keeps paths, queries or foreign origins", () => {
  assert.equal(resourceBucket("http://127.0.0.1:1423/src/main.tsx?secret=private"), "entry");
  assert.equal(resourceBucket("http://127.0.0.1:1423/src/GraphCanvas.tsx"), "canvas");
  assert.equal(resourceBucket("http://127.0.0.1:1423/node_modules/private-name.js"), "dependency");
  assert.equal(resourceBucket("https://private.example/src/main.tsx?token=secret"), "other");
  assert.equal(resourceBucket("not a url"), "other");
});

test("DOM startup observations use only fixed selectors and stop once ready", () => {
  let tick = 10;
  let callback;
  let disconnected = 0;
  const present = new Map();
  const scope = { window: {}, performance: { now: () => tick },
    document: { querySelector: (selector) => present.get(selector) ?? null },
    MutationObserver: class {
      constructor(fn) { callback = fn; }
      observe() {}
      disconnect() { disconnected += 1; }
    },
  };
  runInNewContext(`(${observeStartupDom.toString()})()`, scope);
  tick = 20;
  present.set("#root", { childElementCount: 1 });
  present.set(".storage-problem-shell", {});
  callback();
  tick = 30;
  present.set('[data-testid="graph-canvas"]', {});
  present.set('[data-testid="graph-canvas"][data-flow-ready="true"]', {});
  callback();
  assert.ok(disconnected > 0);
  const dom = sanitizeDom(scope.window.__liStartupDiagnostic());
  assert.equal(dom.firstSeenMs.rootPopulated, 20);
  assert.equal(dom.firstSeenMs.storageGate, 20);
  assert.equal(dom.firstSeenMs.flowReady, 30);
  assert.equal(dom.firstSeenMs.securityGate, null);
  assert.equal(dom.rootHasChildren, true);
});

async function diagnosticFixture() {
  let tick = 0;
  const page = new EventEmitter();
  page.addInitScript = async (fn) => { assert.equal(fn, observeStartupDom); };
  page.evaluate = async () => ({ available: true, sampledAtMs: 12, rootHasChildren: true,
    firstSeenMs: { flowReady: 10, private: "synthetic secret" }, content: "synthetic secret" });
  const finish = await installStartupDiagnostics(page, () => tick);
  const request = { url: () => "http://127.0.0.1:1423/src/main.tsx?token=synthetic-secret" };
  page.emit("request", request);
  tick = 1;
  finish.markNavigationComplete();
  tick = 42;
  page.emit("response", { request: () => request, status: () => 503 });
  page.emit("requestfailed", request);
  page.emit("pageerror", new Error("synthetic secret"));
  page.emit("console", { type: () => "error", text: () => { throw new Error("must not read"); } });
  const pending = { url: () => "http://127.0.0.1:1423/src/MainWorkspace.tsx" };
  page.emit("request", pending);
  tick = 70;
  const diagnostic = await finish();
  assert.equal(page.eventNames().length, 0);
  return diagnostic;
}

test("startup metadata preserves failed and pending requests without retaining secrets", async () => {
  const diagnostic = await diagnosticFixture();
  assert.equal(validateStartupDiagnostic(diagnostic), diagnostic);
  assert.deepEqual(diagnostic.resources.entry, { started: 1, finished: 0, failed: 1,
    httpErrors: 1, pending: 0, firstStartMs: 0, maxDurationMs: 42 });
  assert.equal(diagnostic.resources.workspace.pending, 1);
  assert.equal(diagnostic.resources.workspace.maxDurationMs, 28);
  assert.equal(diagnostic.pageErrors, 1);
  assert.equal(diagnostic.consoleErrors, 1);
  assert.equal(diagnostic.navigationCompletedMs, 1);
  assert.ok(!JSON.stringify(diagnostic).includes("secret"));
});

test("startup tracking is bounded and page loss does not replace the original failure", async () => {
  const page = new EventEmitter();
  page.addInitScript = async () => {};
  page.evaluate = async () => { throw new Error("synthetic private error"); };
  const finish = await installStartupDiagnostics(page, () => 10);
  for (let i = 0; i < 5000; i += 1) page.emit("request", { url: () => "not a url" });
  const diagnostic = validateStartupDiagnostic(await finish());
  assert.equal(diagnostic.resources.other.pending, 4096);
  assert.equal(diagnostic.dropped, 904);
  assert.equal(diagnostic.dom.available, false);
  assert.equal(page.eventNames().length, 0);
});

test("startup report rejects missing, duplicate or unbounded evidence before logging it", async () => {
  const diagnostic = await diagnosticFixture();
  const source = report(true);
  const result = source.suites[0].specs[0].tests[0].results[0];
  const attachment = (value) => ({ name: "startup-diagnostics", contentType: "application/json",
    body: Buffer.from(JSON.stringify(value)).toString("base64") });
  assert.throws(() => startupDiagnosticsFromReport(source));
  result.attachments = [attachment(diagnostic)];
  assert.deepEqual(startupDiagnosticsFromReport(source), diagnostic);
  result.attachments.push(attachment(diagnostic));
  assert.throws(() => startupDiagnosticsFromReport(source));
  result.attachments = [attachment({ ...diagnostic, private: "synthetic secret" })];
  assert.throws(() => startupDiagnosticsFromReport(source), /Invalid startup diagnostic schema/);
  result.attachments = [attachment({ ...diagnostic, elapsedMs: 600_001 })];
  assert.throws(() => startupDiagnosticsFromReport(source), /Invalid startup diagnostic schema/);
});

test("missing diagnostics never short-circuit the original startup failure", async () => {
  const failedReport = report(false, "synthetic startup assertion failed");
  const bothFailed = collectColdStartEvidence("fixed", 1, failedReport, "Vite ready");
  assert.equal(bothFailed.startup, null);
  assert.equal(bothFailed.failures.length, 2);
  assert.match(bothFailed.failures[0].message, /fixed configuration must pass/);
  assert.match(bothFailed.failures[1].message, /Exactly one startup diagnostic/);
  assert.equal(failedReport.suites[0].specs[0].tests[0].results[0].errors[0].message,
    "synthetic startup assertion failed");
  const missingOnly = collectColdStartEvidence("fixed", 0, report(true), "Vite ready");
  assert.equal(missingOnly.failures.length, 1);
  const diagnostic = await diagnosticFixture();
  failedReport.suites[0].specs[0].tests[0].results[0].attachments = [{ name: "startup-diagnostics",
    contentType: "application/json", body: Buffer.from(JSON.stringify(diagnostic)).toString("base64") }];
  const startupFailed = collectColdStartEvidence("fixed", 1, failedReport, "Vite ready");
  assert.equal(startupFailed.failures.length, 1);
  assert.deepEqual(startupFailed.startup, diagnostic);
});

const reloadLog = "new dependencies optimized: @dagrejs/dagre\noptimized dependencies changed. reloading";
const navigationFailure = "A canvas action must not reload the document or discard its undo history";

test("cold-start scratch directories remain under node_modules without touching the filesystem", () => {
  const desktop = path.resolve("synthetic-checkout", "apps", "desktop");
  const prefix = arrangementScratchPrefix(desktop);
  assert.equal(path.dirname(prefix), path.join(desktop, "node_modules"));
  assert.equal(path.basename(prefix), ".linked-info-arrangement-cold-start-");
  for (const variant of ["baseline", "fixed"]) {
    const cache = path.join(`${prefix}synthetic-unique-suffix`, `${variant}-vite-cache`);
    assert.equal(path.relative(desktop, cache).split(path.sep)[0], "node_modules");
    assert.notEqual(cache, path.join(desktop, "node_modules", ".vite"));
  }
});

function report(passed, message = navigationFailure) {
  return {
    errors: [],
    stats: { expected: passed ? 1 : 0, unexpected: passed ? 0 : 1, flaky: 0, skipped: 0 },
    suites: [{ specs: [{
      title: "smart arrangement normalizes width and saves one undoable layout step",
      tests: [{ results: [{ status: passed ? "passed" : "failed", errors: passed ? [] : [{ message }] }] }],
    }] }],
  };
}

test("the default gate runs only the fixed configuration", () => {
  const calls = [];
  const summary = runColdStartValidation([], (variant) => {
    calls.push(variant);
    validateColdStartResult(variant, 0, report(true), "Vite ready");
  });
  assert.deepEqual(calls, ["fixed"]);
  assert.deepEqual(summary, { exitCode: 0, outcomes: [{ variant: "fixed", status: "verified" }] });
});

test("the default gate preserves fixed-configuration failures", () => {
  const failure = new Error("Fixed arrangement assertion failed");
  const summary = runColdStartValidation([], () => { throw failure; });
  assert.equal(summary.exitCode, 1);
  assert.deepEqual(summary.outcomes, [{ variant: "fixed", status: "failed", error: failure }]);
});

test("three explicit startup samples retain every first-attempt outcome without retrying failures", () => {
  let calls = 0;
  const result = runColdStartValidation(["--startup-samples"], (variant) => {
    assert.equal(variant, "fixed");
    calls += 1;
    if (calls === 2) throw new Error("synthetic startup timeout");
  });
  assert.equal(calls, 3);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.outcomes.map((entry) => entry.status), ["verified", "failed", "verified"]);
});

test("the explicit experiment verifies the baseline before independently running the fix", () => {
  const calls = [];
  const summary = runColdStartValidation(["--experiment"], (variant) => {
    calls.push(variant);
    validateColdStartResult(variant, variant === "baseline" ? 1 : 0,
      report(variant === "fixed"), variant === "baseline" ? reloadLog : "Vite ready");
  });
  assert.deepEqual(calls, ["baseline", "fixed"]);
  assert.equal(summary.exitCode, 0);
  assert.deepEqual(summary.outcomes, [
    { variant: "baseline", status: "verified" },
    { variant: "fixed", status: "verified" },
  ]);
});

for (const baseline of [
  { name: "an unrelated timeout", status: 1, report: report(false, "Timeout 5000ms"), log: reloadLog },
  { name: "a run that did not reproduce", status: 0, report: report(true), log: "Vite ready" },
  { name: "missing optimizer evidence", status: 1, report: report(false), log: "Vite ready" },
]) {
  test(`an experiment with ${baseline.name} remains unproven but still runs the fix`, () => {
    const calls = [];
    const summary = runColdStartValidation(["--experiment"], (variant) => {
      calls.push(variant);
      if (variant === "baseline") {
        validateColdStartResult(variant, baseline.status, baseline.report, baseline.log);
      } else {
        validateColdStartResult(variant, 0, report(true), "Vite ready");
      }
    });
    assert.deepEqual(calls, ["baseline", "fixed"]);
    assert.equal(summary.exitCode, 1);
    assert.equal(summary.outcomes[0].status, "not-proven");
    assert.ok(summary.outcomes[0].error instanceof Error);
    assert.deepEqual(summary.outcomes[1], { variant: "fixed", status: "verified" });
  });
}

test("experiment failures retain both outcomes rather than hiding the fixed failure", () => {
  const calls = [];
  const failures = { baseline: new Error("Baseline setup failed"), fixed: new Error("Fixed assertion failed") };
  const summary = runColdStartValidation(["--experiment"], (variant) => {
    calls.push(variant);
    throw failures[variant];
  });
  assert.deepEqual(calls, ["baseline", "fixed"]);
  assert.equal(summary.exitCode, 1);
  assert.deepEqual(summary.outcomes, [
    { variant: "baseline", status: "not-proven", error: failures.baseline },
    { variant: "fixed", status: "failed", error: failures.fixed },
  ]);
});

test("unknown or repeated CLI arguments fail before invoking any runner", () => {
  for (const args of [["--baseline"], ["fixed"], ["--experiment=true"], ["--experiment", "extra"],
    ["--experiment", "--experiment"]]) {
    let called = false;
    assert.throws(() => runColdStartValidation(args, () => { called = true; }), /accepts only --experiment/);
    assert.equal(called, false);
  }
});

test("baseline requires the exact navigation failure and optimizer dependency evidence", () => {
  assert.doesNotThrow(() => validateColdStartResult("baseline", 1, report(false), reloadLog));
  assert.throws(() => validateColdStartResult("baseline", 1, report(false, "Timeout 5000ms"), reloadLog));
  assert.throws(() => validateColdStartResult("baseline", 1, report(false), "@dagrejs/dagre"));
  assert.throws(() => validateColdStartResult("baseline", 1, report(false), "optimized dependencies changed. reloading"));
  assert.throws(() => validateColdStartResult("baseline", 0, report(true), reloadLog));
});

test("fixed requires a first-attempt pass with no optimizer reload", () => {
  assert.doesNotThrow(() => validateColdStartResult("fixed", 0, report(true), "Vite ready"));
  assert.throws(() => validateColdStartResult("fixed", 1, report(false), "Vite ready"));
  assert.throws(() => validateColdStartResult("fixed", 0, report(true), reloadLog));
});

test("navigation diagnostics preserve context-destroyed evidence but reject unrelated action failures", () => {
  const contextDestroyed = report(false);
  contextDestroyed.suites[0].specs[0].tests[0].results[0].errors.push({
    message: "Error: page.evaluate: Execution context was destroyed, most likely because of a navigation\n    at storedWorkspace",
  });
  assert.doesNotThrow(() => validateColdStartResult("baseline", 1, contextDestroyed, reloadLog));
  for (const message of ["Equal-width assertion failed", "Timeout 5000ms waiting for predicate"]) {
    const unrelated = report(false);
    unrelated.suites[0].specs[0].tests[0].results[0].errors.push({ message });
    assert.throws(() => validateColdStartResult("baseline", 1, unrelated, reloadLog));
  }
});

test("unrelated setup errors, retries, missing coverage and flaky results fail closed", () => {
  const setupError = report(false);
  setupError.errors.push({ message: "Server failed to start" });
  assert.throws(() => validateColdStartResult("baseline", 1, setupError, reloadLog));
  const retry = report(true);
  retry.suites[0].specs[0].tests[0].results.unshift({ status: "failed", errors: [{ message: navigationFailure }] });
  assert.throws(() => validateColdStartResult("fixed", 0, retry, "Vite ready"));
  const wrongTest = report(false);
  wrongTest.suites[0].specs[0].title = "some other test";
  assert.throws(() => validateColdStartResult("baseline", 1, wrongTest, reloadLog));
  const flaky = report(true);
  flaky.stats.flaky = 1;
  assert.throws(() => validateColdStartResult("fixed", 0, flaky, "Vite ready"));
});

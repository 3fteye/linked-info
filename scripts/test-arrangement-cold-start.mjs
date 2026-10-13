import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateStartupDiagnostic, validateArrangementDiagnostic } from "../apps/desktop/e2e/fixtures/startup-diagnostics.mjs";

const arrangementTitle = "smart arrangement normalizes width and saves one undoable layout step";
const navigationFailure = "A canvas action must not reload the document or discard its undo history";
const optimizerReload = "optimized dependencies changed. reloading";

function allSpecs(suites) {
  return suites.flatMap((suite) => [...(suite.specs ?? []), ...allSpecs(suite.suites ?? [])]);
}

export function startupDiagnosticsFromReport(report) {
  const attempts = allSpecs(report?.suites ?? []).flatMap((spec) =>
    spec.tests.flatMap((entry) => entry.results));
  assert.equal(attempts.length, 1, "Startup evidence requires one attempt");
  const attachments = (attempts[0].attachments ?? []).filter((entry) => entry.name === "startup-diagnostics");
  assert.equal(attachments.length, 1, "Exactly one startup diagnostic is required");
  const attachment = attachments[0];
  assert.equal(attachment.contentType, "application/json");
  assert.ok(typeof attachment.body === "string" && attachment.body.length < 32_768);
  let value;
  try { value = JSON.parse(Buffer.from(attachment.body, "base64").toString("utf8")); }
  catch { throw new Error("Invalid startup diagnostic encoding"); }
  return validateStartupDiagnostic(value);
}

export function collectColdStartEvidence(variant, status, report, log) {
  const failures = [];
  let startup = null;
  let arrangement = null;
  // Test outcome is primary; missing diagnostics must not short-circuit it.
  try { validateColdStartResult(variant, status, report, log); }
  catch (error) { failures.push(error); }
  try { startup = startupDiagnosticsFromReport(report); }
  catch (error) { failures.push(error); }
  try { arrangement = arrangementDiagnosticsFromReport(report, startup !== null && status === 0); }
  catch (error) { failures.push(error); }
  return { startup, arrangement, failures };
}

export function arrangementDiagnosticsFromReport(report, required = false) {
  const attempts = allSpecs(report?.suites ?? []).flatMap((spec) => spec.tests.flatMap((entry) => entry.results));
  const attachments = attempts.flatMap((attempt) => (attempt.attachments ?? [])
    .filter((entry) => entry.name === "arrangement-diagnostics"));
  if (attachments.length === 0 && !required) return null;
  assert.equal(attachments.length, 1, "Exactly one arrangement diagnostic is required");
  assert.equal(attachments[0].contentType, "application/json");
  assert.ok(typeof attachments[0].body === "string" && attachments[0].body.length < 16_384);
  let value;
  try { value = JSON.parse(Buffer.from(attachments[0].body, "base64").toString("utf8")); }
  catch { throw new Error("Invalid arrangement diagnostic encoding"); }
  return validateArrangementDiagnostic(value);
}

export function arrangementScratchPrefix(desktop) {
  // Match Vite's normal dependency-cache location: React's source transform
  // excludes node_modules, but would re-transform optimized files in OS temp.
  return path.join(desktop, "node_modules", ".linked-info-arrangement-cold-start-");
}

export function validateColdStartResult(variant, status, report, log) {
  assert.ok(["baseline", "fixed", "startup-delay", "worker-delay"].includes(variant), "Unknown cold-start variant");
  assert.deepEqual(report.errors, [], "The runner must not have unrelated setup errors");
  const specs = allSpecs(report.suites);
  assert.equal(specs.length, 1, "Exactly the full arrangement regression must run");
  assert.equal(specs[0].title, arrangementTitle);
  assert.equal(specs[0].tests.length, 1);
  const results = specs[0].tests[0].results;
  assert.equal(results.length, 1, "Retries must not hide a cold-start failure");
  assert.equal(report.stats.flaky, 0);
  assert.equal(report.stats.skipped, 0);
  if (variant === "startup-delay" || variant === "worker-delay") {
    assert.equal(status, 1, "The injected delay must fail the original assertion");
    assert.equal(results[0].status, "failed");
    assert.equal(report.stats.unexpected, 1);
    assert.equal(report.stats.expected, 0);
    assert.equal(log.split(`phase-hold=${variant}`).length - 1, 1, "One precise delay must be observed");
    assert.ok(!log.includes(optimizerReload), "Optimizer reload is not the phase being tested");
    assert.equal(results[0].errors.length, 1, "Unrelated failures invalidate the experiment");
    const message = (results[0].errors[0].message ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(message, /Timeout:\s+5000ms/);
    const startup = startupDiagnosticsFromReport(report);
    assert.equal(startup.pageErrors, 0);
    assert.equal(startup.dropped, 0);
    assert.ok(Object.values(startup.resources).every((row) => row.failed === 0 && row.httpErrors === 0),
      "Unrelated resource failures invalidate the phase experiment");
    assert.equal(startup.dom.available, true);
    assert.equal(startup.dom.firstSeenMs.storageError, null);
    assert.notEqual(startup.navigationCompletedMs, null);
    if (variant === "startup-delay") {
      assert.match(message, /getByTestId\(['"]graph-canvas['"]\)/);
      assert.match(message, /toBeVisible/);
      assert.equal(startup.resources.workspace.pending, 1);
      assert.equal(startup.resources.workspace.finished, 0);
      assert.equal(startup.dom.firstSeenMs.canvas, null);
      assert.equal(startup.dom.rootHasChildren, false);
      assert.equal(arrangementDiagnosticsFromReport(report), null);
    } else {
      assert.match(message, /getByTestId\(['"]smart-arrangement-dialog['"]\)/);
      assert.match(message, /toBeHidden/);
      assert.notEqual(startup.dom.firstSeenMs.flowReady, null);
      const arrangement = arrangementDiagnosticsFromReport(report, true);
      assert.equal(arrangement.domAvailable, true);
      assert.equal(arrangement.dialogPresent, true);
      assert.equal(arrangement.applyDisabled, true);
      assert.equal(arrangement.dialogErrorPresent, false);
      assert.equal(arrangement.closedMs, null);
      assert.equal(arrangement.dropped, 0);
      assert.ok(arrangement.elapsedMs >= 5000);
    }
  } else if (variant === "baseline") {
    assert.equal(status, 1, "The old configuration must reproduce the reload failure");
    assert.equal(results[0].status, "failed");
    assert.equal(report.stats.unexpected, 1);
    assert.equal(report.stats.expected, 0);
    assert.ok(
      results[0].errors.some((error) => error.message?.includes(navigationFailure)),
      "Only the explicit main-frame navigation failure proves the regression",
    );
    assert.ok(
      results[0].errors.every((error) =>
        error.message?.includes(navigationFailure) ||
        /^(?:Error: )?page\.evaluate: Execution context was destroyed, most likely because of a navigation(?:\r?\n|$)/.test(error.message ?? "")),
      "Navigation must not conceal an unrelated action assertion or timeout",
    );
    assert.ok(log.includes("@dagrejs/dagre"), "Vite must identify the newly discovered worker dependency");
    assert.ok(log.includes(optimizerReload), "Vite must report an optimizer-triggered reload");
  } else {
    assert.equal(status, 0, "The fixed configuration must pass on its first cold start");
    assert.equal(results[0].status, "passed");
    assert.equal(report.stats.unexpected, 0);
    assert.equal(report.stats.expected, 1);
    assert.ok(!log.includes(optimizerReload), "The fixed server must not reload optimized dependencies");
  }
}

export function runColdStartValidation(args, runVariant) {
  let variants;
  if (args.length === 0) variants = ["fixed"];
  else if (args.length === 1 && args[0] === "--experiment") variants = ["baseline", "fixed"];
  else if (args.length === 1 && args[0] === "--startup-samples") variants = ["fixed", "fixed", "fixed"];
  else if (args.length === 1 && args[0] === "--phase-experiment") variants = ["startup-delay", "worker-delay", "fixed"];
  else throw new Error("Cold-start validation accepts only --experiment, --startup-samples, --phase-experiment or no arguments");

  // A historical timing failure is experimental evidence, not a prerequisite
  // for exercising the current configuration. Keep both outcomes independent.
  const outcomes = variants.map((variant) => {
    try {
      runVariant(variant);
      return { variant, status: "verified" };
    } catch (error) {
      return { variant, status: variant === "baseline" ? "not-proven" : "failed", error };
    }
  });
  return {
    exitCode: outcomes.every((outcome) => outcome.status === "verified") ? 0 : 1,
    outcomes,
  };
}

function main() {
  if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("Arrangement cold-start validation runs only in GitHub Actions");
  }
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const desktop = path.join(repository, "apps/desktop");
  let sample = 0;
  const summary = runColdStartValidation(process.argv.slice(2), (variant) => {
    // Allocate only after validating the CLI, never reuse a previous run's cache.
    const scratch = mkdtempSync(arrangementScratchPrefix(desktop));
    sample += 1;
    const reportPath = path.join(scratch, `${variant}.json`);
    const result = spawnSync(process.execPath, [
      path.join(desktop, "node_modules/@playwright/test/cli.js"),
      "test", "--config", "playwright.arrangement-cold-start.config.ts",
    ], {
      cwd: desktop,
      encoding: "utf8",
      env: {
        ...process.env,
        DEBUG: "pw:webserver",
        LINKED_INFO_ARRANGEMENT_VARIANT: variant === "baseline" ? "baseline" : "fixed",
        LINKED_INFO_ARRANGEMENT_PHASE_DELAY: variant.endsWith("-delay") ? variant : "",
        LINKED_INFO_ARRANGEMENT_CACHE: path.join(scratch, `${variant}-vite-cache`),
        LINKED_INFO_ARRANGEMENT_OUTPUT: path.join(scratch, `${variant}-test-results`),
        LINKED_INFO_ARRANGEMENT_REPORT: reportPath,
      },
      maxBuffer: 4 * 1024 * 1024,
    });
    const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    let report;
    try {
      if (result.error) throw result.error;
      report = JSON.parse(readFileSync(reportPath, "utf8"));
      const { startup, arrangement, failures } = collectColdStartEvidence(variant, result.status, report, log);
      if (startup !== null) process.stdout.write(`${JSON.stringify({ variant, sample, startup })}\n`);
      if (arrangement !== null) process.stdout.write(`${JSON.stringify({ variant, sample, arrangement })}\n`);
      if (failures.length > 0) {
        throw new AggregateError(failures, failures.map((failure) => failure.message).join("\n"));
      }
    } catch (error) {
      // All browser inputs in this isolated run are the existing synthetic
      // workspace. No app-data files, screenshots, recordings or traces exist.
      process.stderr.write(log);
      const testErrors = allSpecs(report?.suites ?? []).flatMap((spec) =>
        spec.tests.flatMap((testResult) => testResult.results.flatMap((attempt) =>
          attempt.errors.map((failure) => failure.message))),
      );
      process.stderr.write(`${JSON.stringify({ stats: report?.stats, testErrors })}\n`);
      throw new Error(`${variant} cold-start validation failed: ${error.message}`, { cause: error });
    }
    for (const line of log.split(/\r?\n/).filter((line) =>
      line.includes("@dagrejs/dagre") || line.includes(optimizerReload))) {
      process.stdout.write(`${line}\n`);
    }
    const evidence = variant === "baseline"
      ? "dependency=@dagrejs/dagre optimizer-reload=true navigation-failure=true"
      : variant.endsWith("-delay") ? "controlled-timeout=verified historical-cause=unproven"
      : "first-attempt=passed optimizer-reload=false navigation-count=0";
    process.stdout.write(`arrangement-cold-start ${variant}: ${evidence}\n`);
  });
  for (const outcome of summary.outcomes) {
    if (outcome.status !== "verified") {
      process.stderr.write(`arrangement-cold-start ${outcome.variant}: status=${outcome.status}\n`);
      process.stderr.write(`${outcome.error.message}\n`);
    }
  }
  process.exitCode = summary.exitCode;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

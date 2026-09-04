import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const arrangementTitle = "smart arrangement normalizes width and saves one undoable layout step";
const navigationFailure = "A canvas action must not reload the document or discard its undo history";
const optimizerReload = "optimized dependencies changed. reloading";

function allSpecs(suites) {
  return suites.flatMap((suite) => [...(suite.specs ?? []), ...allSpecs(suite.suites ?? [])]);
}

export function arrangementScratchPrefix(desktop) {
  // Match Vite's normal dependency-cache location: React's source transform
  // excludes node_modules, but would re-transform optimized files in OS temp.
  return path.join(desktop, "node_modules", ".linked-info-arrangement-cold-start-");
}

export function validateColdStartResult(variant, status, report, log) {
  assert.ok(variant === "baseline" || variant === "fixed", "Unknown cold-start variant");
  assert.deepEqual(report.errors, [], "The runner must not have unrelated setup errors");
  const specs = allSpecs(report.suites);
  assert.equal(specs.length, 1, "Exactly the full arrangement regression must run");
  assert.equal(specs[0].title, arrangementTitle);
  assert.equal(specs[0].tests.length, 1);
  const results = specs[0].tests[0].results;
  assert.equal(results.length, 1, "Retries must not hide a cold-start failure");
  assert.equal(report.stats.flaky, 0);
  assert.equal(report.stats.skipped, 0);
  if (variant === "baseline") {
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

function main() {
  if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("Arrangement cold-start validation runs only in GitHub Actions");
  }
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const desktop = path.join(repository, "apps/desktop");
  const scratch = mkdtempSync(arrangementScratchPrefix(desktop));
  for (const variant of ["baseline", "fixed"]) {
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
        LINKED_INFO_ARRANGEMENT_VARIANT: variant,
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
      validateColdStartResult(variant, result.status, report, log);
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
      : "first-attempt=passed optimizer-reload=false navigation-count=0";
    process.stdout.write(`arrangement-cold-start ${variant}: ${evidence}\n`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

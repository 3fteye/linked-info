import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  arrangementScratchPrefix, runColdStartValidation, validateColdStartResult,
} from "./test-arrangement-cold-start.mjs";

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

import assert from "node:assert/strict";
import test from "node:test";
import { validateColdStartResult } from "./test-arrangement-cold-start.mjs";

const reloadLog = "new dependencies optimized: @dagrejs/dagre\noptimized dependencies changed. reloading";
const navigationFailure = "A canvas action must not reload the document or discard its undo history";

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

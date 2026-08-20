import assert from "node:assert/strict";
import test from "node:test";

import {
  approvedFrontendLicenseExpressions,
  approvedRustLicenseExpressions,
  findUnapprovedLicenseGroups,
  inspectFrontendLicenses,
} from "./check-dependency-licenses.mjs";

test("license review rejects a new expression until it is approved", () => {
  const failures = findUnapprovedLicenseGroups(
    new Map([["GPL-3.0-only", [{ name: "example", versions: ["1.0.0"] }]]]),
    approvedFrontendLicenseExpressions,
  );

  assert.equal(failures.length, 1);
  assert.equal(failures[0].expression, "GPL-3.0-only");
});

test("license review accepts the explicitly reviewed BSD-2-Clause expression", () => {
  const failures = findUnapprovedLicenseGroups(
    new Map([
      [
        "BSD-2-Clause",
        [{ name: "entities", versions: ["7.0.1"], license: "BSD-2-Clause" }],
      ],
    ]),
    approvedFrontendLicenseExpressions,
  );

  assert.equal(failures.length, 0);
});

test("license review accepts wasmparser's exact reviewed expression", () => {
  const expression =
    "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT";
  const failures = findUnapprovedLicenseGroups(
    new Map([[expression, [{ name: "wasmparser", versions: ["0.256.0"] }]]]),
    approvedRustLicenseExpressions,
  );

  assert.equal(failures.length, 0);
});

test("license review accepts Wasmtime's LLVM-exception expression", () => {
  const expression = "Apache-2.0 WITH LLVM-exception";
  const failures = findUnapprovedLicenseGroups(
    new Map([[expression, [{ name: "wasmtime", versions: ["47.0.3"] }]]]),
    approvedRustLicenseExpressions,
  );

  assert.equal(failures.length, 0);
});

test("license review accepts encoding_rs with its bundled tables license", () => {
  const expression = "(Apache-2.0 OR MIT) AND BSD-3-Clause";
  const failures = findUnapprovedLicenseGroups(
    new Map([[expression, [{ name: "encoding_rs", versions: ["0.8.35"] }]]]),
    approvedRustLicenseExpressions,
  );

  assert.equal(failures.length, 0);
});

test("license review rejects missing license metadata", () => {
  const failures = findUnapprovedLicenseGroups(
    new Map([["", [{ name: "example", versions: ["1.0.0"] }]]]),
    approvedFrontendLicenseExpressions,
  );

  assert.equal(failures.length, 1);
  assert.equal(failures[0].expression, "<missing>");
});

test("pnpm report must keep each package in its declared license group", () => {
  assert.throws(
    () =>
      inspectFrontendLicenses({
        MIT: [{ name: "example", versions: ["1.0.0"], license: "Apache-2.0" }],
      }),
    /grouped example@1\.0\.0 under MIT but reported Apache-2\.0/,
  );
});

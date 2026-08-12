import assert from "node:assert/strict";
import test from "node:test";

import { scanSensitiveSource } from "./check-sensitive-logging.mjs";

test("rejects ordinary Rust and browser logging in sensitive modules", () => {
  const source = [
    "println!(\"{}\", secret);",
    "tracing::debug!(?request);",
    "console.error(modelInput);",
  ].join("\n");

  assert.deepEqual(scanSensitiveSource(source, "sensitive.rs"), [
    "sensitive.rs:1: Rust stdout/stderr/debug macro",
    "sensitive.rs:2: Rust logging facade",
    "sensitive.rs:3: browser console logging",
  ]);
});

test("allows structured errors that do not emit data", () => {
  const source = [
    'return Err("workspace_vault_locked".to_owned());',
    "setError(errorReason(reason));",
  ].join("\n");

  assert.deepEqual(scanSensitiveSource(source, "sensitive.rs"), []);
});

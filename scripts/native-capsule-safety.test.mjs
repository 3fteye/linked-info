import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(repository, "apps/desktop");
const tools = [
  {
    name: "native driver",
    executable: process.execPath,
    args: [path.join(desktop, "scripts/native-capsule-smoke.mjs"),
      "--executable", "not-a-real-main-executable", "--capture-executable", "not-a-real-capture-executable"],
  },
  ...[
    ["native window inspector", "native-capsule-window.ps1", "Paths"],
    ["native window mutation", "native-capsule-window.ps1", "Close"],
    ["debug policy enable", "native-capsule-debug.ps1", "Enable"],
    ["debug policy disable", "native-capsule-debug.ps1", "Disable"],
  ].map(([name, script, action]) => ({
    name,
    executable: "pwsh",
    args: ["-NoProfile", "-NonInteractive", "-File", path.join(repository, ".github/scripts", script), "-Action", action],
  })),
];

// Exercise the same early gate with the independent executable's exact role.
// Invalid CI state must win over path/registry/process validation in both apps.
for (const [name, script, action] of [
  ["capture native window mutation", "native-capsule-window.ps1", "Close"],
  ["capture debug policy enable", "native-capsule-debug.ps1", "Enable"],
  ["capture debug policy disable", "native-capsule-debug.ps1", "Disable"],
]) {
  tools.push({
    name,
    executable: "pwsh",
    args: ["-NoProfile", "-NonInteractive", "-File", path.join(repository, ".github/scripts", script),
      "-Action", action, "-ExecutablePath", path.join(repository, "target/release/linked-info-capture.exe"),
      ...(script === "native-capsule-window.ps1" ? ["-Role", "capsule"] : ["-Port", "9223"])],
  });
}

for (const tool of tools) {
  for (const field of ["GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_OS"]) {
    test(`${tool.name} refuses invalid ${field} before accessing native state`, {
      skip: process.platform !== "win32" && tool.executable === "pwsh",
      timeout: 20_000,
    }, () => {
      const env = {
        ...process.env,
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "github-hosted",
        RUNNER_OS: "Windows",
        [field]: "not-authorized",
      };
      const result = spawnSync(tool.executable, tool.args, {
        cwd: desktop,
        env,
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      });
      assert.equal(result.error, undefined, "guard process must run and exit, not time out");
      assert.notEqual(result.status, 0, "unauthorized native access must be rejected");
      const output = `${result.stdout}\n${result.stderr}`;
      const errors = output.split(/\r?\n/).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      assert.ok(errors.some((entry) => entry.error === "native_capsule_ci_required"),
        "guard must reject before argument paths, registry access or native probing");
    });
  }
}

const driver = readFileSync(path.join(desktop, "scripts/native-capsule-smoke.mjs"), "utf8");

test("native driver checks both executable paths and all four fresh storage roots", () => {
  assert.match(driver, /options\.has\("--executable"\) && options\.has\("--capture-executable"\)/);
  assert.match(driver, /\["main", "main", "--executable", "linked-info-desktop\.exe"\]/);
  assert.match(driver, /\["capsule", "capture", "--capture-executable", "linked-info-capture\.exe"\]/);
  for (const field of ["appDataDirectory", "localDataDirectory", "captureDataDirectory", "captureLocalDataDirectory"]) {
    assert.ok(driver.includes(`locations.${field}`), `must check ${field} before starting either app`);
  }
  assert.ok(driver.indexOf('step("fresh-runner-four-storage-roots"') < driver.indexOf('capture = await launch("capsule")'));
  assert.match(driver, /requireCondition\(!exists, "native_capsule_existing_storage_refused"\)/);
});

test("native driver binds each CDP connection and cleanup to its own child", () => {
  assert.match(driver, /native\("CdpOwner", role, \["-Port", String\(target\.port\)\]\)/);
  assert.match(driver, /noDefaults: true/);
  assert.match(driver, /targets\.main\.port !== targets\.capsule\.port/);
  assert.match(driver, /target\.child = spawn\(target\.executable/);
  assert.match(driver, /target\.child\.kill\(\)/);
  assert.match(driver, /executeHelper\(debugHelper, "Disable", target, \["-Port", String\(target\.port\)\]\)/);
  assert.doesNotMatch(driver, /taskkill|Stop-Process|process\.kill\(|exec\(|shell\s*:\s*true/);
});

test("native driver retains only bounded synthetic measurements and no database files", () => {
  assert.match(driver, /invoke\(main, "inspect_capsule"\)/);
  assert.doesNotMatch(driver, /invoke\(capture, "inspect_capsule"\)/);
  assert.doesNotMatch(driver, /fs\.(?:readFile|readdir|rm|unlink)\(|\.screenshot\(|\.tracing\.|recordVideo\s*:/);
  assert.doesNotMatch(driver, /console\.(?:log|error|warn)|error\.(?:message|stack)|process\.env\.(?:APPDATA|LOCALAPPDATA)\s*=/);
  assert.match(driver, /page\.on\("pageerror", \(\) => \{ report\.summary\.pageErrorCount \+= 1; \}\)/);
});

test("native driver replaces old coupled lifecycle assertions with independent ones", () => {
  for (const name of [
    "capture-starts-before-main-with-owned-cdp",
    "capture-exit-and-restart-restores-local-draft",
    "locked-main-keeps-capture-editable-and-queues-original-date",
    "session-lock-notification-preserves-local-draft",
    "suspend-notification-preserves-local-draft",
    "single-undo-and-receipt-prevent-reimport",
    "capture-exit-does-not-exit-main",
    "main-exit-keeps-capture-running-and-saving",
  ]) assert.ok(driver.includes(name), `must retain ${name}`);
  assert.doesNotMatch(driver, /capsuleInputRemoved|notification-clears-draft|capsule-close-hides-and-main-close-exits/);
});

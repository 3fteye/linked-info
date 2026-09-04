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

test("native archive acknowledgement matches production translations and does not claim history from a toast", () => {
  const locales = readFileSync(path.join(desktop, "src/locales.ts"), "utf8");
  const app = readFileSync(path.join(desktop, "src/App.tsx"), "utf8");
  const productionMessages = [...locales.matchAll(/^\s+archived:\s*"([^"]+)"/gm)]
    .map((match) => match[1]);
  const driverMessages = driver.match(/const ARCHIVE_NOTICE_MESSAGES = (\[[^;]+\]);/);
  assert.notEqual(driverMessages, null, "driver must declare the exact archive acknowledgement texts");
  const acceptedMessages = JSON.parse(driverMessages[1]);
  assert.equal(productionMessages.length, 2, "both archive feedback translations must be present");
  assert.deepEqual(new Set(acceptedMessages), new Set(productionMessages));
  assert.equal(acceptedMessages.includes("Saved"), false);
  assert.equal(acceptedMessages.includes("已保存"), false);
  assert.match(app, /showAppNotice\(t\("capture\.state\.archived"\)\)/);
  assert.match(driver, /main\.evaluate\(\(expectedMessages\) => expectedMessages\.includes\([\s\S]*?ARCHIVE_NOTICE_MESSAGES\)/);
  assert.match(driver, /native_capsule_main_archive_notice_not_observed/);
  assert.doesNotMatch(driver, /native_capsule_main_history_not_applied/);
  assert.match(driver, /main\.keyboard\.press\("Control\+z"\)/);
  assert.match(driver, /validNote\(undone\.notes\[0\]\) && undone\.notes\[1\]\.count === 0/);
});

test("native name-collision regression checks uniform inbox receipts and preserves original workspace data", () => {
  const collisionCase = driver.indexOf('step("name-collision-archives-without-inbox-disclosure"');
  assert.ok(collisionCase > driver.indexOf('step("single-undo-and-receipt-prevent-reimport"'));
  assert.ok(collisionCase > driver.indexOf('step("capture-exit-does-not-exit-main"'));
  assert.ok(collisionCase < driver.indexOf('step("main-exit-keeps-capture-running-and-saving"'));
  assert.match(driver, /const recordKeys = \["capturedAtMs", "content", "failure", "id", "name", "revision", "state", "utcOffsetMinutes"\]/);
  assert.match(driver, /Object\.keys\(value\)\.sort\(\)/);
  assert.match(driver, /record\.name === "" && record\.content === "" && record\.capturedAtMs === null && record\.utcOffsetMinutes === null/);
  assert.match(driver, /record\.failure === null/);
  assert.match(driver, /summary\.name === submitted\.find\(\(\{ id \}\) => id === summary\.id\)\.fixture\.name/);
  assert.match(driver, /archived\.uniformArchivedResult && archived\.archivedCount === 2 && archived\.publicBoundaryPreserved/);
  assert.match(driver, /original\[0\]\.name === expectedSeed\.name && original\[0\]\.content === expectedSeed\.content/);
  assert.match(driver, /collision\[0\]\.name === expectedCollisionName && collision\[0\]\.content === expectedIncoming\[0\]\.content/);
  assert.match(driver, /unique\[0\]\.name === expectedIncoming\[1\]\.name && unique\[0\]\.content === expectedIncoming\[1\]\.content/);
  assert.match(driver, /incomingIds\[0\]\.slice\(0, 8\)/);
});

test("native Unicode collision fixture uses the normal owner-bound snapshot and verifies the legacy name after unlock", () => {
  const start = driver.indexOf('step("legacy-unicode-name-archives-without-disclosure"');
  const end = driver.indexOf('step("main-exit-keeps-capture-running-and-saving"');
  assert.ok(start > driver.indexOf('step("name-collision-archives-without-inbox-disclosure"'));
  assert.ok(end > start);
  const unicodeCase = driver.slice(start, end);
  assert.ok(unicodeCase.includes('const legacyName = "\\u0085" + base;'));
  assert.match(unicodeCase, /node\.name = legacyName;/);
  assert.match(unicodeCase, /nativeInvoke\("lock_workspace_with_snapshot", \{ ownerId, contents: JSON\.stringify\(document\) \}\)/);
  assert.match(unicodeCase, /requireCondition\(oldOwnerRejected,/);
  assert.match(unicodeCase, /const current = await unlock\(main, syntheticPassword\)/);
  assert.match(unicodeCase, /current\.ownerId !== before\.ownerId/);
  assert.ok(unicodeCase.indexOf("requireCondition(legacyReloaded,") <
    unicodeCase.indexOf("archiveFixturesWithoutNameDisclosure(capture, [incoming])"));
  assert.match(unicodeCase, /original\[0\]\.name === legacyName && original\[0\]\.content === originalContent/);
  assert.match(unicodeCase, /original\[0\]\.name === legacyName && original\[0\]\.content === expectedSeed\.content/);
  assert.match(unicodeCase, /added\[0\]\.name === expectedName && added\[0\]\.content === expectedIncoming\.content/);
  assert.match(unicodeCase, /archived\.uniformArchivedResult && archived\.archivedCount === 1 && archived\.publicBoundaryPreserved/);
  assert.doesNotMatch(unicodeCase, /capture_(?:create|save|submit)|write_workspace_file|fs\.(?:writeFile|readFile)/);
});

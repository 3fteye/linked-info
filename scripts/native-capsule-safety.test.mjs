import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CapsuleHelperFailure, executeNativeCapsuleHelper, HELPER_ERROR_CODES,
  HELPER_PHASES, HELPER_TIMEOUT_MS } from "../apps/desktop/scripts/native-capsule-helper.mjs";

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

function helperScenario({ events = [], error = null, stdout = '{"windows":[]}', stderr = "", finishedAt = 100 } = {}) {
  let now = 0;
  const calls = [];
  const completion = executeNativeCapsuleHelper({
    script: "synthetic-helper.ps1", kind: "window", role: "capture", action: "Inspect", executable: "synthetic.exe",
    clock: () => now,
    execFile: (command, args, options, callback) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        for (const event of events) {
          now = event.at;
          if (event.spawn) child.emit("spawn");
          else child.stderr.emit("data", event.text);
        }
        now = finishedAt;
        callback(error, stdout, stderr);
      });
      return child;
    },
  });
  return { calls, completion };
}
const phaseLine = (phase, elapsedMs) => `${JSON.stringify({ phase, elapsedMs })}\n`;

test("helper timing distinguishes process spawn, script entry, compile and native execution", async () => {
  const { calls, completion } = helperScenario({ events: [
    { at: 3, spawn: true },
    { at: 200, text: '{"phase":"script_' },
    { at: 201, text: 'entered","elapsedMs":0}\n' },
    { at: 220, text: phaseLine("interop_compile_started", 20) },
    { at: 800, text: phaseLine("interop_compile_completed", 600) },
    { at: 802, text: phaseLine("window_inspect_started", 602) },
    { at: 804, text: phaseLine("window_inspect_completed", 604) },
    { at: 805, text: phaseLine("response_ready", 605) },
  ], finishedAt: 900 });
  const { response, diagnostic } = await completion;
  assert.deepEqual(response, { windows: [] });
  assert.equal(diagnostic.spawnElapsedMs, 3);
  assert.deepEqual(diagnostic.phases[0], { phase: "script_entered", helperElapsedMs: 0, observedElapsedMs: 201 });
  assert.equal(diagnostic.phases[2].helperElapsedMs - diagnostic.phases[1].helperElapsedMs, 580);
  assert.equal(diagnostic.durationMs, 900);
  assert.equal(diagnostic.budgetElapsed, false);
  assert.equal(diagnostic.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeout, 20_000);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.maxBuffer, 64 * 1024);
});

test("a killed helper retains its last checkpoint and deadline observation without retrying", async () => {
  const { calls, completion } = helperScenario({ events: [
    { at: 4, spawn: true },
    { at: 200, text: phaseLine("script_entered", 0) },
    { at: 230, text: phaseLine("interop_compile_started", 30) },
  ], error: { code: null, killed: true, signal: "SIGTERM", message: "synthetic private arguments" }, finishedAt: 20_033 });
  await assert.rejects(completion, (error) => {
    assert.ok(error instanceof CapsuleHelperFailure);
    assert.equal(error.code, "native_capsule_helper_failed");
    assert.equal(error.diagnostic.phases.at(-1).phase, "interop_compile_started");
    assert.equal(error.diagnostic.durationMs, 20_033);
    assert.equal(error.diagnostic.budgetElapsed, true);
    assert.equal(error.diagnostic.killed, true);
    assert.equal(error.diagnostic.signal, "SIGTERM");
    assert.equal(error.diagnostic.exitCode, null);
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /private/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(HELPER_TIMEOUT_MS, 20_000, "diagnostics must not relax the failing budget");
});

test("helper launch failure remains distinct from a spawned process with no script checkpoint", async () => {
  for (const launched of [false, true]) {
    const { completion } = helperScenario({
      events: launched ? [{ at: 2, spawn: true }] : [],
      error: launched ? { code: null, killed: true, signal: "SIGTERM" } : { code: "ENOENT" },
      finishedAt: launched ? 20_001 : 2,
    });
    await assert.rejects(completion, (error) => {
      assert.equal(error.diagnostic.spawnObserved, launched);
      assert.deepEqual(error.diagnostic.phases, []);
      assert.equal(error.diagnostic.processError, launched ? null : "ENOENT");
      assert.equal(error.diagnostic.budgetElapsed, launched);
      return true;
    });
  }
});

test("diagnostics reject arbitrary errors, stdout, stderr, phase fields and unbounded lines", async () => {
  const privateText = "synthetic-private-title-and-command";
  const malformed = [
    { phase: privateText, elapsedMs: 1 },
    { phase: "paths_resolved", elapsedMs: 1, title: privateText },
    { phase: "paths_resolved", elapsedMs: -1 },
    { phase: "paths_resolved", elapsedMs: "1" },
    { phase: "paths_resolved", elapsedMs: Number.MAX_SAFE_INTEGER },
    { phase: "paths_resolved", elapsedMs: 0.25 },
  ];
  const { completion } = helperScenario({ events: [
    { at: 1, text: phaseLine("script_entered", 0) },
    { at: 2, text: malformed.map((value) => `${JSON.stringify(value)}\n`).join("") },
    { at: 3, text: privateText.repeat(80) },
    { at: 4, text: `\n${phaseLine("interop_compile_started", 4)}` },
    { at: 5, text: phaseLine("interop_compile_started", 5) + phaseLine("paths_resolved", 1) },
  ], error: { code: privateText, signal: privateText, killed: false },
  stdout: JSON.stringify({ error: `native_capsule_${privateText}` }),
  stderr: `${privateText}\n${JSON.stringify({ error: "native_capsule_process_unavailable", title: privateText })}` });
  await assert.rejects(completion, (error) => {
    assert.deepEqual(error.diagnostic.phases.map((entry) => entry.phase), ["script_entered", "interop_compile_started"]);
    assert.equal(error.diagnostic.processError, "other");
    assert.equal(error.diagnostic.signal, "other");
    assert.equal(error.diagnostic.helperError, null);
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /synthetic-private/);
    return true;
  });
});

test("only exact declared helper errors survive failure reporting", async () => {
  const { completion } = helperScenario({ error: { code: 1 },
    stderr: '{"error":"native_capsule_process_unavailable"}\n' });
  await assert.rejects(completion, (error) => {
    assert.equal(error.diagnostic.helperError, "native_capsule_process_unavailable");
    assert.equal(error.diagnostic.exitCode, 1);
    return true;
  });
});

test("invalid successful helper response fails closed without retaining response text", async () => {
  const { completion } = helperScenario({ stdout: "synthetic private response" });
  await assert.rejects(completion, (error) => {
    assert.equal(error.code, "native_capsule_helper_response_invalid");
    assert.equal(error.diagnostic.exitCode, 0);
    assert.doesNotMatch(JSON.stringify(error), /synthetic private/);
    return true;
  });
});

test("phase and error allowlists cover the helpers without broadening their report boundary", () => {
  const windowHelper = readFileSync(path.join(repository, ".github/scripts/native-capsule-window.ps1"), "utf8");
  const debugHelper = readFileSync(path.join(repository, ".github/scripts/native-capsule-debug.ps1"), "utf8");
  const declaredErrors = new Set([...`${windowHelper}\n${debugHelper}`.matchAll(/native_capsule_[a-z_]+/g)]
    .map((match) => match[0]));
  assert.deepEqual(new Set(HELPER_ERROR_CODES), declaredErrors);
  const emittedPhases = [...windowHelper.matchAll(/Write-CapsulePhase "([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(new Set(HELPER_PHASES), new Set(emittedPhases));
  assert.ok(windowHelper.indexOf('Stop-CapsuleHelper "native_capsule_ci_required"') <
    windowHelper.indexOf('$phaseClock = [Diagnostics.Stopwatch]::StartNew()'));
  assert.match(windowHelper, /\[Console\]::Error\.Flush\(\)/);
  assert.match(windowHelper, /Write-CapsulePhase "interop_compile_started"\s+Add-Type[\s\S]*?Write-CapsulePhase "interop_compile_completed"/);
  assert.match(windowHelper, /Write-CapsulePhase "window_inspect_started"\s+\$windows = @\(\[LinkedInfo\.CiCapsule\.Native\]::Inspect/);
  assert.match(driver, /report\.summary\.firstHelperFailure \?\?= error\.diagnostic/);
  assert.match(driver, /report\.helperCalls\.length > 256/);
  assert.match(driver, /"native_capsule_helper_failed", "native_capsule_helper_response_invalid"\]\.includes\(error\.code\)\) throw error/);
});

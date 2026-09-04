// This driver is intentionally unusable on a developer's Windows account.
if (
  process.platform !== "win32" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  process.env.RUNNER_OS !== "Windows"
) {
  process.stdout.write(`${JSON.stringify({ error: "native_capsule_ci_required" })}\n`);
  process.exit(1);
}
// Never retain protocol, console, DOM, exception text, screenshots or traces.
delete process.env.DEBUG;
delete process.env.PWDEBUG;

class SmokeFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireCondition(condition, code) {
  if (!condition) throw new SmokeFailure(code);
}
// Keep the production archive feedback distinct from a local-save receipt.
// The safety regression compares these exact texts with capture.state.archived.
const ARCHIVE_NOTICE_MESSAGES = ["Archived to the main workspace", "已归档到主工作区"];
const report = {
  schemaVersion: 2, environment: "github-hosted-windows", status: "running", tests: [],
  summary: { passed: 0, failed: 0, pageErrorCount: 0, nativeSessionNotificationsOnly: true,
    actualOperatingSystemLockOrSuspendTested: false },
};
let writeReport;

async function run() {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const net = await import("node:net");
  const { fileURLToPath } = await import("node:url");
  const { spawn, execFile } = await import("node:child_process");
  const { setTimeout: delay } = await import("node:timers/promises");
  const options = new Map();
  const permittedOptions = new Set(["--executable", "--capture-executable", "--report"]);
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    requireCondition(permittedOptions.has(key) && typeof value === "string" &&
      value.length > 0 && !options.has(key), "native_capsule_invalid_arguments");
    options.set(key, value);
  }
  requireCondition(options.has("--executable") && options.has("--capture-executable"),
    "native_capsule_executable_required");
  const repository = await fs.realpath(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "../../.."));
  const targets = {};
  for (const [role, label, option, filename] of [
    ["main", "main", "--executable", "linked-info-desktop.exe"],
    ["capsule", "capture", "--capture-executable", "linked-info-capture.exe"],
  ]) {
    const executable = await fs.realpath(options.get(option));
    requireCondition(executable.toLowerCase() ===
      path.join(repository, "target", "release", filename).toLowerCase(),
    "native_capsule_executable_out_of_scope");
    targets[role] = { role, label, executable, child: null, exited: false, spawnFailed: false,
      expectedAlive: false, browser: null, debugPolicyEnabled: false, port: null };
  }
  const nativeHelper = await fs.realpath(path.join(repository, ".github/scripts/native-capsule-window.ps1"));
  const debugHelper = await fs.realpath(path.join(repository, ".github/scripts/native-capsule-debug.ps1"));
  if (options.has("--report")) {
    const reportPath = path.resolve(options.get("--report"));
    const relative = path.relative(repository, reportPath);
    requireCondition(relative.length > 0 && !relative.startsWith("..") &&
      !path.isAbsolute(relative) && path.extname(reportPath) === ".json", "native_capsule_report_out_of_scope");
    writeReport = async () => {
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    };
  }
  const observedPages = new Set();
  const reservedPorts = new Set();
  let chromium;

  function assertAlive(target) {
    requireCondition(target.child !== null && !target.exited && !target.spawnFailed &&
      target.child.exitCode === null, "native_capsule_spawned_process_exited");
  }
  async function executeHelper(helper, action, target = targets.main, extra = []) {
    return new Promise((resolve, reject) => {
      execFile("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helper,
        "-Action", action, "-ExecutablePath", target.executable, ...extra], {
        windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024, encoding: "utf8",
      }, (error, stdout, stderr) => {
        if (error !== null) {
          report.summary.lastHelperAction = action;
          report.summary.lastHelperExitCode = typeof error.code === "number" ? error.code : null;
          for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
            try {
              const code = JSON.parse(line).error;
              if (typeof code === "string" && /^native_capsule_[a-z_]{1,100}$/.test(code)) report.summary.lastHelperError = code;
            } catch { /* Only recognized fixed helper codes may enter reports. */ }
          }
          reject(new SmokeFailure("native_capsule_helper_failed"));
          return;
        }
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, "").trim())); }
        catch { reject(new SmokeFailure("native_capsule_helper_response_invalid")); }
      });
    });
  }
  async function native(action, role = "capsule", extra = []) {
    const target = targets[role];
    assertAlive(target);
    return executeHelper(nativeHelper, action, target,
      ["-ProcessId", String(target.child.pid), "-Role", role, ...extra]);
  }
  async function poll(check, code, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const target of Object.values(targets)) if (target.expectedAlive) assertAlive(target);
      try { const result = await check(); if (result) return result; }
      catch (error) {
        if (error instanceof SmokeFailure && error.code === "native_capsule_spawned_process_exited") throw error;
      }
      await delay(100);
    }
    throw new SmokeFailure(code);
  }
  async function step(name, operation) {
    const startedAt = Date.now();
    try {
      const measurements = await operation();
      report.tests.push({ name, status: "passed", durationMs: Date.now() - startedAt,
        ...(measurements === undefined ? {} : { measurements }) });
      process.stdout.write(`${JSON.stringify({ test: name, status: "passed" })}\n`);
    } catch (error) {
      const code = error instanceof SmokeFailure ? error.code : `native_capsule_${name.replaceAll("-", "_")}_failed`;
      report.tests.push({ name, status: "failed", error: code, durationMs: Date.now() - startedAt });
      throw new SmokeFailure(code);
    }
  }
  async function pageFor(role) {
    const target = targets[role];
    return poll(async () => {
      const matches = [];
      for (const context of target.browser.contexts()) for (const page of context.pages()) {
        if (!observedPages.has(page)) {
          observedPages.add(page);
          page.on("pageerror", () => { report.summary.pageErrorCount += 1; });
          page.setDefaultTimeout(15_000);
        }
        const identity = await page.evaluate(() => ({
          window: window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label,
          webview: window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label,
          view: document.documentElement.dataset.window,
        })).catch(() => null);
        if (identity?.window === target.label && identity.webview === target.label && identity.view === target.label) matches.push(page);
      }
      requireCondition(matches.length <= 1, "native_capsule_duplicate_window_label");
      return matches[0] ?? false;
    }, "native_capsule_window_label_unavailable", 60_000);
  }
  async function invoke(page, command, args = {}) {
    return page.evaluate(({ commandName, parameters }) => window.__TAURI_INTERNALS__.invoke(commandName, parameters),
      { commandName: command, parameters: args });
  }
  async function readyContext(main) {
    return poll(async () => {
      const state = await invoke(main, "inspect_capsule");
      return state.ready === true && typeof state.ownerId === "string" && typeof state.contextId === "string" ? state : false;
    }, "native_capsule_owner_not_ready");
  }
  async function reservePort() {
    const port = await new Promise((resolve, reject) => {
      const reservation = net.createServer();
      reservation.once("error", () => reject(new SmokeFailure("native_capsule_port_unavailable")));
      reservation.listen(0, "127.0.0.1", () => {
        const address = reservation.address();
        if (address === null || typeof address === "string" || address.port < 1024) {
          reservation.close(); reject(new SmokeFailure("native_capsule_port_unavailable")); return;
        }
        reservation.close((error) => error ? reject(new SmokeFailure("native_capsule_port_unavailable")) : resolve(address.port));
      });
    });
    requireCondition(!reservedPorts.has(port), "native_capsule_duplicate_cdp_port");
    reservedPorts.add(port);
    return port;
  }
  async function launch(role) {
    const target = targets[role];
    requireCondition(target.child === null || target.exited, "native_capsule_duplicate_process_launch");
    requireCondition(typeof process.env.RUNNER_TEMP === "string" && path.isAbsolute(process.env.RUNNER_TEMP),
      "native_capsule_runner_temp_invalid");
    const runnerTemp = await fs.realpath(process.env.RUNNER_TEMP);
    const profile = await fs.mkdtemp(path.join(runnerTemp, `linked-info-native-${target.label}-`));
    if (!target.debugPolicyEnabled) {
      target.port = await reservePort();
      const enabled = await executeHelper(debugHelper, "Enable", target, ["-Port", String(target.port)]);
      requireCondition(enabled.enabled === true, "native_capsule_debug_enable_unconfirmed");
      target.debugPolicyEnabled = true;
    }
    target.exited = false; target.spawnFailed = false; target.expectedAlive = true;
    target.child = spawn(target.executable, [], {
      cwd: path.dirname(target.executable), windowsHide: true, stdio: "ignore",
      env: { ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${target.port}`,
        WEBVIEW2_USER_DATA_FOLDER: profile },
    });
    target.child.once("error", () => { target.spawnFailed = true; target.exited = true; });
    target.child.once("exit", () => { target.exited = true; });
    await poll(async () => (await native("CdpOwner", role, ["-Port", String(target.port)])).owned === true,
      "native_capsule_cdp_endpoint_not_owned", 90_000);
    if (chromium === undefined) {
      try { ({ chromium } = await import("@playwright/test")); }
      catch { throw new SmokeFailure("native_capsule_playwright_dependency_unavailable"); }
    }
    try {
      // Preserve real Win32 focus rather than per-page focus emulation.
      target.browser = await chromium.connectOverCDP(`http://127.0.0.1:${target.port}`, { timeout: 20_000, noDefaults: true });
    } catch { throw new SmokeFailure("native_capsule_cdp_connect_failed"); }
    return pageFor(role);
  }
  async function windowInfo(role) {
    const windows = (await native("Inspect", role)).windows.filter((window) => window.role === role);
    requireCondition(windows.length === 1, "native_capsule_native_window_not_unique");
    return windows[0];
  }
  async function focus(page, role) {
    await native("Focus", role);
    await poll(() => page.evaluate(() => document.hasFocus()), "native_capsule_native_focus_failed");
  }
  async function waitForExit(target, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!target.exited && Date.now() < deadline) await delay(100);
    if (target.exited) target.expectedAlive = false;
    return target.exited;
  }
  async function close(role) {
    const target = targets[role];
    await native("Close", role);
    requireCondition(await waitForExit(target, 30_000), "native_capsule_close_did_not_exit");
    requireCondition(target.child.exitCode === 0, "native_capsule_process_exit_not_clean");
    if (target.browser !== null) await target.browser.close().catch(() => {});
    target.browser = null;
  }
  async function expand(capture) {
    if (await capture.getByTestId("capture-content").count() === 0) await capture.getByTestId("capture-toggle").click();
    await capture.getByTestId("capture-content").waitFor({ state: "visible" });
  }
  async function localSaved(capture, state = "draft") {
    await poll(async () => await capture.getByTestId("capture-status").getAttribute("data-local") === "saved" &&
      await capture.getByTestId("capture-status").getAttribute("data-state") === state, "native_capsule_local_save_not_confirmed");
  }
  async function newDraft(capture, note) {
    await focus(capture, "capsule"); await expand(capture);
    await capture.getByTestId("capture-new").click();
    await poll(() => capture.getByTestId("capture-content").evaluate((element) => !element.readOnly),
      "native_capsule_new_draft_not_editable");
    await capture.getByTestId("capture-name").fill(note.name);
    await capture.getByTestId("capture-content").fill(note.content);
    await localSaved(capture);
  }
  async function archiveFixturesWithoutNameDisclosure(capture, fixtures) {
    return capture.evaluate(async (expectedFixtures) => {
      const nativeInvoke = window.__TAURI_INTERNALS__.invoke;
      const recordKeys = ["capturedAtMs", "content", "failure", "id", "name", "revision", "state", "utcOffsetMinutes"];
      const summaryKeys = recordKeys.filter((key) => key !== "content");
      const sameKeys = (value, expected) => value !== null && typeof value === "object" &&
        JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
      const submitted = [];
      let inputSnapshotsPreserved = true;
      let publicBoundaryPreserved = true;
      for (const fixture of expectedFixtures) {
        const created = await nativeInvoke("capture_create");
        const saved = await nativeInvoke("capture_save", { id: created.id, expectedRevision: created.revision,
          name: fixture.name, content: fixture.content });
        const pending = await nativeInvoke("capture_submit", { id: saved.id, expectedRevision: saved.revision,
          capturedAtMs: Date.now(), utcOffsetMinutes: -new Date().getTimezoneOffset() });
        publicBoundaryPreserved &&= [created, saved, pending].every((record) => sameKeys(record, recordKeys) && record.failure === null);
        inputSnapshotsPreserved &&= [saved, pending].every((record) =>
          record.id === created.id && record.name === fixture.name && record.content === fixture.content);
        submitted.push({ id: pending.id, revision: pending.revision, fixture });
      }
      let replies = [];
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        replies = await Promise.all(submitted.map(({ id }) => nativeInvoke("capture_get", { id })));
        publicBoundaryPreserved &&= replies.every((record, index) => sameKeys(record, recordKeys) &&
          record.id === submitted[index].id && record.revision === submitted[index].revision && record.failure === null &&
          (record.state === "archived"
            ? record.name === "" && record.content === "" && record.capturedAtMs === null && record.utcOffsetMinutes === null
            : record.name === submitted[index].fixture.name && record.content === submitted[index].fixture.content));
        const summaries = await nativeInvoke("capture_list");
        const tracked = summaries.filter((summary) => submitted.some(({ id }) => id === summary.id));
        publicBoundaryPreserved &&= tracked.every((summary) => sameKeys(summary, summaryKeys) && summary.failure === null &&
          summary.name === submitted.find(({ id }) => id === summary.id).fixture.name);
        if (!publicBoundaryPreserved || replies.some((record) => record?.state === "failed" || record?.state === "uncertain")) break;
        if (replies.every((record) => record?.state === "archived")) {
          return { ids: submitted.map(({ id }) => id), inputSnapshotsPreserved, publicBoundaryPreserved,
            uniformArchivedResult: true, archivedCount: replies.length, absentFromInboxList: tracked.length === 0 };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { ids: submitted.map(({ id }) => id), inputSnapshotsPreserved, publicBoundaryPreserved,
        uniformArchivedResult: false, archivedCount: replies.filter((record) => record?.state === "archived").length,
        absentFromInboxList: false };
    }, fixtures);
  }
  const notes = [
    { name: "Synthetic standalone first", content: "Synthetic first line\nSynthetic second line" },
    { name: "Synthetic standalone second", content: "Synthetic real-window blur record" },
    { name: "Synthetic locked capture", content: "Synthetic input while the main workspace is locked" },
    { name: "Synthetic historical capture", content: "Synthetic original-date archive", capturedAtMs: 1_577_930_400_000, utcOffsetMinutes: -480 },
  ];
  // Complete workspace snapshots stay in the owning main page. Only counts and
  // comparisons against synthetic fixtures return to this driver.
  async function snapshot(main) {
    const context = await readyContext(main);
    return main.evaluate(async ({ ownerId, expectedNotes }) => {
      const contents = await window.__TAURI_INTERNALS__.invoke("read_workspace_file", { slot: "primary", ownerId });
      if (contents === null) return null;
      const document = JSON.parse(contents);
      const captures = document.view.timeline?.captures ?? [];
      const days = document.view.timeline?.days ?? [];
      return {
        version: document.version, nodeCount: document.nodes.length, referenceCount: document.references.length,
        captureCount: captures.length, dayCount: days.length,
        notes: expectedNotes.map((expected) => {
          const matches = document.nodes.filter((node) => node.name === expected.name);
          const node = matches[0];
          const capture = captures.find((item) => item.nodeId === node?.id);
          const day = days.find((item) => item.date === capture?.day);
          return {
            count: matches.length, contentMatches: node?.content === expected.content, captured: capture !== undefined,
            originalTimeMatches: expected.capturedAtMs === undefined ||
              (capture?.capturedAtMs === expected.capturedAtMs && capture?.utcOffsetMinutes === expected.utcOffsetMinutes &&
                capture?.day === new Date(expected.capturedAtMs + expected.utcOffsetMinutes * 60_000).toISOString().slice(0, 10)),
            dayReference: day !== undefined && document.references.some((reference) =>
              reference.sourceNodeId === node?.id && reference.targetNodeId === day.nodeId),
          };
        }),
      };
    }, { ownerId: context.ownerId, expectedNotes: notes });
  }
  async function waitCaptures(main, count) {
    return poll(async () => { const value = await snapshot(main); return value?.captureCount === count ? value : false; },
      "native_capsule_archive_count_not_confirmed", 60_000);
  }
  function validNote(note) {
    return note.count === 1 && note.contentMatches && note.captured && note.dayReference && note.originalTimeMatches;
  }
  async function unlock(main, password) {
    await focus(main, "main");
    await main.locator("#workspace-unlock-password").fill(password);
    await main.locator(".security-unlock-form button[type=submit]").click();
    await main.locator("#workspace-unlock-password").waitFor({ state: "detached", timeout: 45_000 });
    return readyContext(main);
  }

  try {
    await step("fresh-runner-four-storage-roots", async () => {
      const locations = await executeHelper(nativeHelper, "Paths");
      const expected = [[locations.appDataDirectory, "com.linkedinfo.desktop"],
        [locations.localDataDirectory, "com.linkedinfo.desktop"], [locations.captureDataDirectory, "com.linkedinfo.capture"],
        [locations.captureLocalDataDirectory, "com.linkedinfo.capture"]];
      requireCondition(new Set(expected.map(([directory]) => directory)).size === 4, "native_capsule_storage_path_invalid");
      for (const [directory, identifier] of expected) {
        requireCondition(typeof directory === "string" && path.isAbsolute(directory) && path.basename(directory) === identifier,
          "native_capsule_storage_path_invalid");
        let exists = true;
        try { await fs.lstat(directory); } catch (error) {
          if (error.code === "ENOENT") exists = false;
          else throw new SmokeFailure("native_capsule_storage_probe_failed");
        }
        requireCondition(!exists, "native_capsule_existing_storage_refused");
      }
      return { storageRootsChecked: 4, existingStorageTouched: false };
    });
    let capture;
    let main;
    await step("capture-starts-before-main-with-owned-cdp", async () => {
      capture = await launch("capsule");
      await capture.getByTestId("capture-app").waitFor({ state: "visible" });
      requireCondition(targets.main.child === null, "native_capsule_main_started_early");
      return { mainStarted: false, captureEndpointOwnedBySpawnedProcess: true };
    });
    await step("native-capture-geometry-and-drag", async () => {
      const collapsed = await windowInfo("capsule");
      requireCondition(collapsed.visible && collapsed.topmost && collapsed.clientTopInset >= 0 &&
        collapsed.clientTopInset <= Math.ceil(collapsed.dpi / 96) + 1, "native_capsule_window_style_invalid");
      requireCondition(Math.abs(collapsed.clientWidth * 96 / collapsed.dpi - 220) <= 4 &&
        Math.abs(collapsed.clientHeight * 96 / collapsed.dpi - 56) <= 4, "native_capsule_collapsed_size_invalid");
      await focus(capture, "capsule"); await expand(capture); await localSaved(capture);
      const expanded = await windowInfo("capsule");
      requireCondition(Math.abs(expanded.clientWidth * 96 / expanded.dpi - 420) <= 4 &&
        Math.abs(expanded.clientHeight * 96 / expanded.dpi - 360) <= 4 && expanded.clientTopInset >= 0 &&
        expanded.clientTopInset <= Math.ceil(expanded.dpi / 96) + 1, "native_capsule_expanded_size_invalid");
      await native("Drag");
      const moved = await windowInfo("capsule");
      requireCondition(Math.abs(moved.x - expanded.x) >= 20 && Math.abs(moved.y - expanded.y) >= 10 &&
        moved.clientWidth === expanded.clientWidth && moved.clientHeight === expanded.clientHeight, "native_capsule_drag_did_not_move_window");
      return { topmost: true, borderless: true, collapsedWidth: 220, expandedWidth: 420, dragMovedWindow: true };
    });
    await step("ordinary-enter-and-collapse-preserve-local-draft", async () => {
      await capture.getByTestId("capture-name").fill(notes[0].name);
      const editor = capture.getByTestId("capture-content");
      await editor.fill("Synthetic first line"); await editor.press("Enter");
      await capture.keyboard.insertText("Synthetic second line");
      requireCondition(await editor.inputValue() === notes[0].content, "native_capsule_enter_not_newline");
      await localSaved(capture);
      await capture.getByTestId("capture-toggle").click();
      await editor.waitFor({ state: "detached" });
      const onlyDraft = await capture.evaluate(async () => {
        const summaries = await window.__TAURI_INTERNALS__.invoke("capture_list");
        return summaries.length === 1 && summaries[0].state === "draft";
      });
      requireCondition(onlyDraft, "native_capsule_collapse_submitted");
      await expand(capture);
      requireCondition(await editor.inputValue() === notes[0].content, "native_capsule_collapse_lost_draft");
      return { ordinaryEnterSubmitted: false, localDraftDurable: true, collapseSubmitted: false };
    });
    await step("capture-exit-and-restart-restores-local-draft", async () => {
      await close("capsule");
      requireCondition(targets.main.child === null, "native_capsule_exit_started_main");
      capture = await launch("capsule"); await focus(capture, "capsule"); await expand(capture); await localSaved(capture);
      requireCondition(await capture.getByTestId("capture-name").inputValue() === notes[0].name &&
        await capture.getByTestId("capture-content").inputValue() === notes[0].content, "native_capsule_restart_lost_draft");
      return { captureExitedCleanly: true, localDraftRestored: true, mainStarted: false };
    });
    await step("ctrl-enter-queues-without-main", async () => {
      await capture.getByTestId("capture-content").press("Control+Enter"); await localSaved(capture, "pending");
      const pending = await capture.evaluate(async (name) => {
        const records = await window.__TAURI_INTERNALS__.invoke("capture_list");
        const matches = records.filter((record) => record.name === name);
        return { count: matches.length, state: matches[0]?.state, capturedAtMs: matches[0]?.capturedAtMs,
          utcOffsetMinutes: matches[0]?.utcOffsetMinutes };
      }, notes[0].name);
      requireCondition(pending.count === 1 && pending.state === "pending" && Number.isSafeInteger(pending.capturedAtMs),
        "native_capsule_pending_not_durable");
      notes[0].capturedAtMs = pending.capturedAtMs; notes[0].utcOffsetMinutes = pending.utcOffsetMinutes;
      return { queuedLocally: true, mainStarted: false, archivedBeforeMain: false };
    });
    await step("main-independent-cdp-archives-once", async () => {
      main = await launch("main");
      const saved = await waitCaptures(main, 1);
      requireCondition(targets.main.child.pid !== targets.capsule.child.pid && targets.main.port !== targets.capsule.port &&
        saved.version === 6 && saved.nodeCount === 2 && saved.dayCount === 1 && saved.referenceCount === 1 && validNote(saved.notes[0]),
      "native_capsule_first_note_transaction_invalid");
      await localSaved(capture, "archived");
      requireCondition(await capture.getByTestId("capture-content").inputValue() === "", "native_capsule_archived_body_retained");
      return { distinctProcesses: true, distinctCdpPorts: true, captures: 1, dates: 1 };
    });
    await step("native-blur-submits-complete-date-transaction", async () => {
      await newDraft(capture, notes[1]); await focus(main, "main");
      requireCondition(!await capture.evaluate(() => document.hasFocus()), "native_capsule_blur_not_native");
      const saved = await waitCaptures(main, 2);
      requireCondition(validNote(saved.notes[0]) && validNote(saved.notes[1]) &&
        saved.nodeCount === saved.captureCount + saved.dayCount && saved.referenceCount === saved.captureCount + saved.dayCount - 1,
      "native_capsule_blur_transaction_invalid");
      await localSaved(capture, "archived");
      await poll(() => main.evaluate((expectedMessages) => expectedMessages.includes(
        document.querySelector(".app-status-toast > span")?.textContent ?? ""), ARCHIVE_NOTICE_MESSAGES),
      "native_capsule_main_archive_notice_not_observed");
      return { captures: 2, dates: saved.dayCount, reusedDateNode: saved.dayCount === 1 };
    });
    await step("single-undo-and-receipt-prevent-reimport", async () => {
      await focus(main, "main"); await main.keyboard.press("Control+z");
      const undone = await waitCaptures(main, 1);
      requireCondition(validNote(undone.notes[0]) && undone.notes[1].count === 0, "native_capsule_undo_transaction_invalid");
      await delay(2_500);
      requireCondition((await snapshot(main)).captureCount === 1, "native_capsule_receipt_reimported_undo");
      return { capturesAfterOneUndo: 1, consumedRecordReimported: false };
    });
    await step("capture-sensitive-commands-rejected", async () => {
      const context = await readyContext(main);
      const rejected = await capture.evaluate(async ({ ownerId }) => {
        const requests = [["read_workspace_file", { ownerId, slot: "primary" }],
          ["unlock_workspace", { password: "Synthetic rejected password" }], ["restart_application", {}], ["inspect_capsule", {}]];
        const results = [];
        for (const [command, parameters] of requests) {
          try { await window.__TAURI_INTERNALS__.invoke(command, parameters); results.push(false); }
          catch (error) { results.push(error === "capture_command_denied"); }
        }
        return results;
      }, { ownerId: context.ownerId });
      requireCondition(rejected.length === 4 && rejected.every(Boolean), "native_capsule_command_isolation_failed");
      return { forbiddenCommandsRejected: 4 };
    });
    const syntheticPassword = "native standalone test phrase 2026";
    await step("enable-encryption-with-synthetic-master-password", async () => {
      const before = await readyContext(main);
      await focus(main, "main");
      await main.getByTestId("settings-navigation").click(); await main.getByTestId("settings-tab-dataSecurity").click();
      await main.locator("#settings-panel-dataSecurity .security-settings-actions > button.primary-button").click();
      await main.locator("#workspace-security-password").fill(syntheticPassword);
      await main.locator("#workspace-security-password-confirmation").fill(syntheticPassword);
      await main.locator(".security-dialog-form button[type=submit]").click();
      await main.locator("#workspace-security-password").waitFor({ state: "detached", timeout: 45_000 });
      const current = await readyContext(main);
      const security = await invoke(main, "inspect_workspace_security");
      requireCondition(current.encrypted === true && current.ownerId !== before.ownerId && security.encrypted === true &&
        security.locked === false && security.systemUnlockEnabled === false, "native_capsule_encryption_owner_not_renewed");
      requireCondition((await snapshot(main)).captureCount === 1, "native_capsule_encryption_changed_workspace");
      return { encrypted: true, systemQuickUnlockEnabled: false };
    });
    await step("pending-main-snapshot-survives-lock", async () => {
      const context = await readyContext(main);
      const pendingContent = "Synthetic latest edit admitted before lock";
      await main.evaluate(async ({ ownerId, name, content }) => {
        const nativeInvoke = window.__TAURI_INTERNALS__.invoke;
        const document = JSON.parse(await nativeInvoke("read_workspace_file", { ownerId, slot: "primary" }));
        const node = document.nodes.find((entry) => entry.name === name);
        if (node === undefined) throw new Error("synthetic_node_missing");
        node.content = content;
        await nativeInvoke("lock_workspace_with_snapshot", { ownerId, contents: JSON.stringify(document) });
      }, { ownerId: context.ownerId, name: notes[0].name, content: pendingContent });
      await main.locator("#workspace-unlock-password").waitFor({ state: "visible" });
      const locked = await invoke(main, "inspect_capsule");
      requireCondition(!locked.ready && locked.ownerId === null, "native_capsule_final_snapshot_did_not_lock");
      const nextOwner = await unlock(main, syntheticPassword);
      notes[0].content = pendingContent;
      const loaded = await snapshot(main);
      requireCondition(nextOwner.ownerId !== context.ownerId && loaded.captureCount === 1 && validNote(loaded.notes[0]),
        "native_capsule_pending_edit_lost_on_lock");
      return { pendingSnapshotPersisted: true, oldOwnerRevoked: true };
    });
    await step("locked-main-keeps-capture-editable-and-queues-original-date", async () => {
      const oldOwner = await readyContext(main);
      await invoke(main, "lock_workspace"); await main.locator("#workspace-unlock-password").waitFor({ state: "visible" });
      await newDraft(capture, notes[2]);
      await capture.getByTestId("capture-content").press("Control+Enter"); await localSaved(capture, "pending");
      // Normal bounded IPC, with a historical synthetic timestamp. No test
      // backdoor, OS clock mutation, shell read or direct database access.
      const historicalQueued = await capture.evaluate(async (note) => {
        const nativeInvoke = window.__TAURI_INTERNALS__.invoke;
        const created = await nativeInvoke("capture_create");
        const saved = await nativeInvoke("capture_save", { id: created.id, expectedRevision: created.revision,
          name: note.name, content: note.content });
        const pending = await nativeInvoke("capture_submit", { id: saved.id, expectedRevision: saved.revision,
          capturedAtMs: note.capturedAtMs, utcOffsetMinutes: note.utcOffsetMinutes });
        return pending.state === "pending" && pending.capturedAtMs === note.capturedAtMs;
      }, notes[3]);
      requireCondition(historicalQueued, "native_capsule_historical_capture_not_pending");
      const oldReadRejected = await main.evaluate(async ({ ownerId }) => {
        try { await window.__TAURI_INTERNALS__.invoke("read_workspace_file", { ownerId, slot: "primary" }); return false; }
        catch { return true; }
      }, { ownerId: oldOwner.ownerId });
      requireCondition(oldReadRejected, "native_capsule_locked_authority_accepted");
      requireCondition((await invoke(main, "inspect_workspace_security")).locked === true, "native_capsule_capture_unlocked_main");
      const nextOwner = await unlock(main, syntheticPassword);
      const saved = await waitCaptures(main, 3);
      requireCondition(nextOwner.ownerId !== oldOwner.ownerId && validNote(saved.notes[2]) && validNote(saved.notes[3]) &&
        saved.dayCount >= 2, "native_capsule_original_date_archive_invalid");
      await localSaved(capture, "archived");
      return { captureEditableWhileLocked: true, oldReadRejected, originalDatePreserved: true, captures: 3 };
    });
    let captureCount = 3;
    for (const [action, name] of [["SessionLock", "session-lock-notification-preserves-local-draft"],
      ["Suspend", "suspend-notification-preserves-local-draft"]]) {
      await step(name, async () => {
        const oldOwner = await readyContext(main);
        const note = { name: `Synthetic ${action} draft`, content: `Synthetic ${action} local text` };
        notes.push(note); await newDraft(capture, note); await native(action, "main");
        await main.locator("#workspace-unlock-password").waitFor({ state: "visible" });
        requireCondition(await capture.getByTestId("capture-content").inputValue() === note.content, "native_capsule_notification_lost_draft");
        note.content += " edited while locked";
        await capture.getByTestId("capture-content").fill(note.content); await localSaved(capture);
        const rejected = await main.evaluate(async ({ ownerId }) => {
          try { await window.__TAURI_INTERNALS__.invoke("read_workspace_file", { ownerId, slot: "primary" }); return false; }
          catch { return true; }
        }, { ownerId: oldOwner.ownerId });
        requireCondition(rejected, "native_capsule_notification_kept_authority");
        // Real focus to the unlock form submits the draft while still locked.
        const current = await unlock(main, syntheticPassword); captureCount += 1;
        const saved = await waitCaptures(main, captureCount);
        requireCondition(current.ownerId !== oldOwner.ownerId && validNote(saved.notes.at(-1)), "native_capsule_notification_archive_invalid");
        await localSaved(capture, "archived");
        return { mainLocked: true, localDraftRetained: true, lockedEditingAllowed: true, oldReadRejected: true,
          notificationInjected: true, operatingSystemActuallyLockedOrSuspended: false };
      });
    }
    await step("capture-exit-does-not-exit-main", async () => {
      await close("capsule"); assertAlive(targets.main);
      requireCondition((await snapshot(main)).captureCount === captureCount, "native_capsule_capture_exit_changed_main");
      capture = await launch("capsule"); await expand(capture); await localSaved(capture);
      return { captureExitedCleanly: true, mainRemainedRunning: true };
    });
    await step("name-collision-archives-without-inbox-disclosure", async () => {
      // Seed via normal capture IPC so its stable identity is known without
      // reading any node identity, name or body out of the main page.
      const seed = { name: "Synthetic collision seed", content: "Synthetic original seed body must remain unchanged" };
      const incoming = [
        { name: seed.name, content: "Synthetic colliding capture body must remain verbatim" },
        { name: "Synthetic previously unused capture name", content: "Synthetic unique capture body must remain verbatim" },
      ];
      const seeded = await archiveFixturesWithoutNameDisclosure(capture, [seed]);
      requireCondition(seeded.uniformArchivedResult && seeded.archivedCount === 1 && seeded.publicBoundaryPreserved &&
        seeded.inputSnapshotsPreserved && seeded.absentFromInboxList, "native_capsule_collision_seed_not_archived");
      let context = await readyContext(main);
      const seedPresent = await main.evaluate(async ({ ownerId, id, expected }) => {
        const contents = await window.__TAURI_INTERNALS__.invoke("read_workspace_file", { ownerId, slot: "primary" });
        const document = JSON.parse(contents);
        const matches = document.nodes.filter((node) => node.id === id);
        return matches.length === 1 && matches[0].name === expected.name && matches[0].content === expected.content;
      }, { ownerId: context.ownerId, id: seeded.ids[0], expected: seed });
      requireCondition(seedPresent, "native_capsule_collision_seed_missing");
      const archived = await archiveFixturesWithoutNameDisclosure(capture, incoming);
      requireCondition(archived.uniformArchivedResult && archived.archivedCount === 2 && archived.publicBoundaryPreserved &&
        archived.inputSnapshotsPreserved && archived.absentFromInboxList, "native_capsule_name_collision_result_disclosed");
      context = await readyContext(main);
      const verified = await main.evaluate(async ({ ownerId, seedId, incomingIds, expectedSeed, expectedIncoming, expectedCount }) => {
        const contents = await window.__TAURI_INTERNALS__.invoke("read_workspace_file", { ownerId, slot: "primary" });
        const document = JSON.parse(contents);
        const original = document.nodes.filter((node) => node.id === seedId);
        const collision = document.nodes.filter((node) => node.id === incomingIds[0]);
        const unique = document.nodes.filter((node) => node.id === incomingIds[1]);
        const expectedCollisionName = `${expectedIncoming[0].name} (${incomingIds[0].slice(0, 8)})`;
        const captures = document.view.timeline?.captures ?? [];
        return {
          originalNodeUnchanged: original.length === 1 && original[0].name === expectedSeed.name && original[0].content === expectedSeed.content,
          collidingNodeAdded: collision.length === 1 && collision[0].name === expectedCollisionName && collision[0].content === expectedIncoming[0].content,
          uniqueNodeAdded: unique.length === 1 && unique[0].name === expectedIncoming[1].name && unique[0].content === expectedIncoming[1].content,
          identitiesRemainDistinct: new Set([seedId, ...incomingIds]).size === 3,
          ordinaryCapturesRetained: [seedId, ...incomingIds].every((id) => captures.filter((entry) => entry.nodeId === id).length === 1),
          expectedCaptureCount: captures.length === expectedCount,
          newNodes: collision.length + unique.length,
        };
      }, { ownerId: context.ownerId, seedId: seeded.ids[0], incomingIds: archived.ids,
        expectedSeed: seed, expectedIncoming: incoming, expectedCount: captureCount + 3 });
      requireCondition(verified.originalNodeUnchanged && verified.collidingNodeAdded && verified.uniqueNodeAdded &&
        verified.identitiesRemainDistinct && verified.ordinaryCapturesRetained && verified.expectedCaptureCount && verified.newNodes === 2,
      "native_capsule_name_collision_workspace_invalid");
      captureCount += 3;
      return { bothInputsArchived: true, inboxExposesOnlyOriginalInputAndMinimalReceipts: true,
        originalNodeUnchanged: true, collidingAndUniqueBodiesPreserved: true, newNodes: 2 };
    });
    await step("legacy-unicode-name-archives-without-disclosure", async () => {
      const seed = { name: "Synthetic legacy Unicode seed", content: "Synthetic legacy body must remain unchanged" };
      const base = "Synthetic previously unused Unicode collision base";
      const legacyName = "\u0085" + base;
      const incoming = { name: base, content: "Synthetic Unicode collision body must remain verbatim" };
      const seeded = await archiveFixturesWithoutNameDisclosure(capture, [seed]);
      requireCondition(seeded.uniformArchivedResult && seeded.archivedCount === 1 && seeded.publicBoundaryPreserved &&
        seeded.inputSnapshotsPreserved && seeded.absentFromInboxList, "native_capsule_unicode_seed_not_archived");
      const before = await readyContext(main);
      requireCondition(before.encrypted === true, "native_capsule_unicode_setup_requires_encryption");
      // Do not create the legacy name through capture: its current naming
      // policy would trim U+0085 before the fixture ever reached the workspace.
      // This is the existing main-owner final-snapshot command, not a file edit.
      const locked = await main.evaluate(async ({ ownerId, seedId, expectedSeed, base, legacyName }) => {
        const nativeInvoke = window.__TAURI_INTERNALS__.invoke;
        const document = JSON.parse(await nativeInvoke("read_workspace_file", { ownerId, slot: "primary" }));
        const matches = document.nodes.filter((entry) => entry.id === seedId);
        if (matches.length !== 1 || matches[0].name !== expectedSeed.name || matches[0].content !== expectedSeed.content ||
          document.nodes.some((entry) => entry.name === base || entry.name === legacyName)) return false;
        const node = matches[0];
        node.name = legacyName;
        const status = await nativeInvoke("lock_workspace_with_snapshot", { ownerId, contents: JSON.stringify(document) });
        return status.locked === true;
      }, { ownerId: before.ownerId, seedId: seeded.ids[0], expectedSeed: seed, base, legacyName });
      requireCondition(locked, "native_capsule_unicode_legacy_setup_failed");
      await main.locator("#workspace-unlock-password").waitFor({ state: "visible" });
      const oldOwnerRejected = await main.evaluate(async ({ ownerId }) => {
        try { await window.__TAURI_INTERNALS__.invoke("read_workspace_file", { ownerId, slot: "primary" }); return false; }
        catch { return true; }
      }, { ownerId: before.ownerId });
      requireCondition(oldOwnerRejected, "native_capsule_unicode_setup_kept_old_authority");
      const current = await unlock(main, syntheticPassword);
      requireCondition(current.ownerId !== before.ownerId, "native_capsule_unicode_setup_reused_owner");
      // Assert the actual persisted legacy spelling after the new owner has
      // loaded its authoritative snapshot; otherwise this would miss the bug.
      const legacyReloaded = await main.evaluate(async ({ ownerId, seedId, legacyName, originalContent, base }) => {
        const contents = await window.__TAURI_INTERNALS__.invoke("read_workspace_file", { ownerId, slot: "primary" });
        const document = JSON.parse(contents);
        const original = document.nodes.filter((entry) => entry.id === seedId);
        return original.length === 1 && original[0].name === legacyName && original[0].content === originalContent &&
          !document.nodes.some((entry) => entry.name === base);
      }, { ownerId: current.ownerId, seedId: seeded.ids[0], legacyName, originalContent: seed.content, base });
      requireCondition(legacyReloaded, "native_capsule_unicode_legacy_name_not_reloaded");
      const archived = await archiveFixturesWithoutNameDisclosure(capture, [incoming]);
      requireCondition(archived.uniformArchivedResult && archived.archivedCount === 1 && archived.publicBoundaryPreserved &&
        archived.inputSnapshotsPreserved && archived.absentFromInboxList, "native_capsule_unicode_collision_result_disclosed");
      const verified = await main.evaluate(async ({ ownerId, seedId, incomingId, legacyName, expectedSeed, expectedIncoming, expectedCount }) => {
        const contents = await window.__TAURI_INTERNALS__.invoke("read_workspace_file", { ownerId, slot: "primary" });
        const document = JSON.parse(contents);
        const original = document.nodes.filter((entry) => entry.id === seedId);
        const added = document.nodes.filter((entry) => entry.id === incomingId);
        const expectedName = `${expectedIncoming.name} (${incomingId.slice(0, 8)})`;
        const captures = document.view.timeline?.captures ?? [];
        return {
          originalNodeUnchanged: original.length === 1 && original[0].name === legacyName && original[0].content === expectedSeed.content,
          suffixNodeAdded: added.length === 1 && added[0].name === expectedName && added[0].content === expectedIncoming.content,
          identitiesRemainDistinct: seedId !== incomingId,
          ordinaryCapturesRetained: [seedId, incomingId].every((id) => captures.filter((entry) => entry.nodeId === id).length === 1),
          expectedCaptureCount: captures.length === expectedCount,
        };
      }, { ownerId: current.ownerId, seedId: seeded.ids[0], incomingId: archived.ids[0], legacyName,
        expectedSeed: seed, expectedIncoming: incoming, expectedCount: captureCount + 2 });
      requireCondition(verified.originalNodeUnchanged && verified.suffixNodeAdded && verified.identitiesRemainDistinct &&
        verified.ordinaryCapturesRetained && verified.expectedCaptureCount, "native_capsule_unicode_collision_workspace_invalid");
      captureCount += 2;
      return { legacyNameReloadedThroughNewOwner: true, oldOwnerRejected: true, originalNodeUnchanged: true,
        collidingBodyPreserved: true, uniformArchivedResult: true, derivedNameDisclosedToInbox: false };
    });
    await step("main-exit-keeps-capture-running-and-saving", async () => {
      await close("main"); assertAlive(targets.capsule);
      const standalone = { name: "Synthetic after main exit", content: "Synthetic durable standalone draft" };
      await newDraft(capture, standalone); await close("capsule");
      capture = await launch("capsule"); await expand(capture); await localSaved(capture);
      requireCondition(await capture.getByTestId("capture-content").inputValue() === standalone.content,
        "native_capsule_main_exit_draft_not_restored");
      requireCondition(targets.main.exited, "native_capsule_restarted_main_implicitly");
      await close("capsule");
      requireCondition(report.summary.pageErrorCount === 0, "native_capsule_page_errors_detected");
      return { mainExitedCleanly: true, captureRemainedRunning: true, draftRestoredWithoutMain: true };
    });
  } finally {
    // Cleanup uses only original ChildProcess handles and exact policy values.
    // App-data roots and temporary WebView profiles are never deleted.
    for (const target of Object.values(targets)) {
      if (target.child !== null && !target.exited && !target.spawnFailed) {
        try {
          await native("Close", target.role).catch(() => {});
          if (!await waitForExit(target, 10_000)) {
            target.child.kill();
            requireCondition(await waitForExit(target, 10_000), "native_capsule_owned_process_cleanup_failed");
          }
        } catch {
          if (!target.exited) {
            target.child.unref();
            report.tests.push({ name: `owned-${target.label}-cleanup`, status: "failed", error: "native_capsule_owned_process_cleanup_failed" });
          }
        }
      }
      if (target.browser !== null) await target.browser.close().catch(() => {});
      report.summary[`${target.label}ProcessExited`] = target.exited;
      report.summary[`${target.label}ProcessExitCode`] = typeof target.child?.exitCode === "number" ? target.child.exitCode : null;
      if (target.debugPolicyEnabled) {
        try {
          const disabled = await executeHelper(debugHelper, "Disable", target, ["-Port", String(target.port)]);
          requireCondition(disabled.disabled === true, "native_capsule_debug_cleanup_failed");
        } catch {
          report.tests.push({ name: `debug-${target.label}-cleanup`, status: "failed", error: "native_capsule_debug_cleanup_failed" });
        }
      }
    }
  }
}
try { await run(); } catch (error) {
  report.error = error instanceof SmokeFailure ? error.code : "native_capsule_driver_failed";
}
report.summary.passed = report.tests.filter((test) => test.status === "passed").length;
report.summary.failed = report.tests.filter((test) => test.status === "failed").length;
report.status = report.error === undefined && report.summary.failed === 0 ? "passed" : "failed";
if (writeReport !== undefined) {
  try { await writeReport(); } catch { report.error = "native_capsule_report_write_failed"; report.status = "failed"; }
}
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.status === "passed" ? 0 : 1;

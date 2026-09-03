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

// Disable protocol/debug output before loading Playwright. No console, DOM,
// pageerror messages, screenshots, videos, or traces belong in this report.
delete process.env.DEBUG;
delete process.env.PWDEBUG;

class SmokeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireCondition(condition, code) {
  if (!condition) throw new SmokeFailure(code);
}

const report = {
  schemaVersion: 1,
  environment: "github-hosted-windows",
  status: "running",
  tests: [],
  summary: {
    passed: 0,
    failed: 0,
    pageErrorCount: 0,
    nativeSessionNotificationsOnly: true,
    actualOperatingSystemLockOrSuspendTested: false,
  },
};

let reportPath;
let writeReport;

async function run() {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const net = await import("node:net");
  const { fileURLToPath } = await import("node:url");
  const { spawn, execFile } = await import("node:child_process");
  const { setTimeout: delay } = await import("node:timers/promises");

  const options = new Map();
  const permittedOptions = new Set(["--executable", "--report"]);
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    requireCondition(
      permittedOptions.has(key) && typeof value === "string" &&
        value.length > 0 && !options.has(key),
      "native_capsule_invalid_arguments",
    );
    options.set(key, value);
  }
  requireCondition(options.has("--executable"), "native_capsule_executable_required");

  const repository = await fs.realpath(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "../../..",
  ));
  const executable = await fs.realpath(options.get("--executable"));
  const expectedExecutable = path.join(repository, "target", "release", "linked-info-desktop.exe");
  requireCondition(
    executable.toLowerCase() === expectedExecutable.toLowerCase(),
    "native_capsule_executable_out_of_scope",
  );
  const nativeHelper = await fs.realpath(
    path.join(repository, ".github", "scripts", "native-capsule-window.ps1"));
  const debugHelper = await fs.realpath(
    path.join(repository, ".github", "scripts", "native-capsule-debug.ps1"));

  if (options.has("--report")) {
    reportPath = path.resolve(options.get("--report"));
    const relative = path.relative(repository, reportPath);
    requireCondition(
      relative.length > 0 && !relative.startsWith("..") &&
        !path.isAbsolute(relative) && path.extname(reportPath) === ".json",
      "native_capsule_report_out_of_scope",
    );
    writeReport = async () => {
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: "utf8", flag: "wx",
      });
    };
  }

  let child = null;
  let childExited = false;
  let childSpawnFailed = false;
  let browser = null;
  let debugPolicyEnabled = false;
  let port;
  const pageErrors = new Set();

  function assertChildAlive() {
    requireCondition(
      child !== null && !childExited && !childSpawnFailed && child.exitCode === null,
      "native_capsule_spawned_process_exited",
    );
  }

  async function executeHelper(helper, action, extra = []) {
    return new Promise((resolve, reject) => {
      execFile("pwsh", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-File", helper,
        "-Action", action, "-ExecutablePath", executable, ...extra,
      ], {
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      }, (error, stdout, stderr) => {
        if (error !== null) {
          report.summary.lastHelperAction = action;
          report.summary.lastHelperExitCode = typeof error.code === "number" ? error.code : null;
          // Helpers emit a fixed JSON error code. Retain that code for CI
          // diagnosis without copying PowerShell/native error text or paths.
          for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
            try {
              const code = JSON.parse(line).error;
              if (typeof code === "string" && /^native_capsule_[a-z_]{1,100}$/.test(code)) {
                report.summary.lastHelperError = code;
              }
            } catch { /* Ignore everything except a recognized helper code. */ }
          }
          reject(new SmokeFailure("native_capsule_helper_failed"));
          return;
        }
        try {
          resolve(JSON.parse(stdout.replace(/^\uFEFF/, "").trim()));
        } catch {
          reject(new SmokeFailure("native_capsule_helper_response_invalid"));
        }
      });
    });
  }

  async function native(action, role = "capsule", extra = []) {
    assertChildAlive();
    return executeHelper(nativeHelper, action, [
      "-ProcessId", String(child.pid), "-Role", role, ...extra,
    ]);
  }

  async function poll(check, code, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertChildAlive();
      try {
        const result = await check();
        if (result) return result;
      } catch (error) {
        if (error instanceof SmokeFailure && error.code === "native_capsule_spawned_process_exited") {
          throw error;
        }
      }
      await delay(100);
    }
    throw new SmokeFailure(code);
  }

  async function step(name, operation) {
    const startedAt = Date.now();
    try {
      const measurements = await operation();
      report.tests.push({
        name, status: "passed", durationMs: Date.now() - startedAt,
        ...(measurements === undefined ? {} : { measurements }),
      });
      process.stdout.write(`${JSON.stringify({ test: name, status: "passed" })}\n`);
    } catch (error) {
      const code = error instanceof SmokeFailure
        ? error.code : `native_capsule_${name.replaceAll("-", "_")}_failed`;
      report.tests.push({ name, status: "failed", error: code, durationMs: Date.now() - startedAt });
      throw new SmokeFailure(code);
    }
  }

  function observePage(page) {
    if (pageErrors.has(page)) return;
    pageErrors.add(page);
    page.on("pageerror", () => { report.summary.pageErrorCount += 1; });
    page.setDefaultTimeout(15_000);
  }

  async function pageFor(label) {
    return poll(async () => {
      const matches = [];
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          observePage(page);
          const identity = await page.evaluate(() => ({
            window: window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label,
            webview: window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label,
            view: document.documentElement.dataset.window,
          })).catch(() => null);
          if (identity?.window === label && identity.webview === label && identity.view === label) {
            matches.push(page);
          }
        }
      }
      requireCondition(matches.length <= 1, "native_capsule_duplicate_window_label");
      return matches[0] ?? false;
    }, "native_capsule_window_label_unavailable", 60_000);
  }

  async function invoke(page, command, args = {}) {
    return page.evaluate(({ commandName, parameters }) =>
      window.__TAURI_INTERNALS__.invoke(commandName, parameters),
    { commandName: command, parameters: args });
  }

  async function readyContext(capsule) {
    return poll(async () => {
      const state = await invoke(capsule, "inspect_capsule");
      return state.ready === true && typeof state.ownerId === "string" &&
        typeof state.contextId === "string" ? state : false;
    }, "native_capsule_owner_not_ready");
  }

  const notes = [
    { name: "Synthetic native capsule first", content: "Synthetic first line\nSynthetic second line" },
    { name: "Synthetic native capsule second", content: "Synthetic real-window blur record" },
  ];

  async function snapshot(main, capsule) {
    const context = await readyContext(capsule);
    return main.evaluate(async ({ ownerId, expectedNotes }) => {
      const contents = await window.__TAURI_INTERNALS__.invoke("read_workspace_file", {
        slot: "primary", ownerId,
      });
      if (contents === null) return null;
      const document = JSON.parse(contents);
      const timeline = document.view.timeline;
      const captures = timeline?.captures ?? [];
      const days = timeline?.days ?? [];
      return {
        version: document.version,
        nodeCount: document.nodes.length,
        referenceCount: document.references.length,
        captureCount: captures.length,
        dayCount: days.length,
        activeCanvasId: document.view.activeCanvasId,
        dayIdentities: days.map((day) => day.nodeId).join(","),
        notes: expectedNotes.map((expected) => {
          const matches = document.nodes.filter((node) => node.name === expected.name);
          const node = matches[0];
          const capture = captures.find((item) => item.nodeId === node?.id);
          const day = days.find((item) => item.date === capture?.day);
          return {
            count: matches.length,
            contentMatches: node?.content === expected.content,
            captured: capture !== undefined,
            dayReference: day !== undefined && document.references.some((reference) =>
              reference.sourceNodeId === node?.id && reference.targetNodeId === day.nodeId),
          };
        }),
      };
    }, { ownerId: context.ownerId, expectedNotes: notes });
  }

  async function windowInfo(role) {
    const result = await native("Inspect", role);
    const windows = result.windows.filter((window) => window.role === role);
    requireCondition(windows.length === 1, "native_capsule_native_window_not_unique");
    return windows[0];
  }

  async function focus(page, role) {
    await native("Focus", role);
    await poll(() => page.evaluate(() => document.hasFocus()), "native_capsule_native_focus_failed");
  }

  async function waitForExit(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!childExited && Date.now() < deadline) await delay(100);
    return childExited;
  }

  try {
    await step("fresh-runner-storage", async () => {
      const locations = await executeHelper(nativeHelper, "Paths");
      for (const directory of new Set([locations.appDataDirectory, locations.localDataDirectory])) {
        requireCondition(
          typeof directory === "string" && path.isAbsolute(directory) &&
            path.basename(directory) === "com.linkedinfo.desktop",
          "native_capsule_storage_path_invalid",
        );
        let exists = true;
        try { await fs.lstat(directory); } catch (error) {
          if (error.code === "ENOENT") exists = false;
          else throw new SmokeFailure("native_capsule_storage_probe_failed");
        }
        requireCondition(!exists, "native_capsule_existing_storage_refused");
      }
      return { existingStorageTouched: false };
    });

    await step("owned-webview2-cdp", async () => {
      requireCondition(
        typeof process.env.RUNNER_TEMP === "string" && path.isAbsolute(process.env.RUNNER_TEMP),
        "native_capsule_runner_temp_invalid",
      );
      const runnerTemp = await fs.realpath(process.env.RUNNER_TEMP);
      const webviewProfile = await fs.mkdtemp(path.join(runnerTemp, "linked-info-native-capsule-"));
      port = await new Promise((resolve, reject) => {
        const reservation = net.createServer();
        reservation.once("error", () => reject(new SmokeFailure("native_capsule_port_unavailable")));
        reservation.listen(0, "127.0.0.1", () => {
          const address = reservation.address();
          if (address === null || typeof address === "string" || address.port < 1024) {
            reservation.close();
            reject(new SmokeFailure("native_capsule_port_unavailable"));
            return;
          }
          reservation.close((error) => error
            ? reject(new SmokeFailure("native_capsule_port_unavailable")) : resolve(address.port));
        });
      });
      const enabled = await executeHelper(debugHelper, "Enable", ["-Port", String(port)]);
      requireCondition(enabled.enabled === true, "native_capsule_debug_enable_unconfirmed");
      debugPolicyEnabled = true;
      child = spawn(executable, [], {
        cwd: path.dirname(executable),
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
            `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
          WEBVIEW2_USER_DATA_FOLDER: webviewProfile,
        },
      });
      child.once("error", () => { childSpawnFailed = true; childExited = true; });
      child.once("exit", () => { childExited = true; });
      await poll(async () => {
        const ownership = await native("CdpOwner", "main", ["-Port", String(port)]);
        return ownership.owned === true;
      }, "native_capsule_cdp_endpoint_not_owned", 90_000);
      let chromium;
      try { ({ chromium } = await import("@playwright/test")); } catch {
        throw new SmokeFailure("native_capsule_playwright_dependency_unavailable");
      }
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20_000 });
      } catch {
        throw new SmokeFailure("native_capsule_cdp_connect_failed");
      }
      return { endpointOwnedBySpawnedProcess: true };
    });

    let main = await pageFor("main");
    let capsule;
    let initialCanvasId;
    let dayIdentities;

    await step("native-window-labels-and-geometry", async () => {
      await main.getByTestId("capsule-open").waitFor({ state: "visible" });
      await focus(main, "main");
      await main.getByTestId("capsule-open").click();
      capsule = await pageFor("capsule");
      await readyContext(capsule);
      const initial = await poll(async () => {
        const loaded = await snapshot(main, capsule);
        return loaded !== null ? loaded : false;
      }, "native_capsule_initial_workspace_unavailable");
      requireCondition(initial.version === 6 && initial.nodeCount === 0, "native_capsule_workspace_not_empty");
      initialCanvasId = initial.activeCanvasId;
      const collapsed = await windowInfo("capsule");
      report.summary.collapsedWindow = {
        visible: collapsed.visible,
        topmost: collapsed.topmost,
        captionStyle: collapsed.captionStyle,
        styleBits: collapsed.styleBits,
        extendedStyleBits: collapsed.extendedStyleBits,
        width: collapsed.width,
        height: collapsed.height,
        clientWidth: collapsed.clientWidth,
        clientHeight: collapsed.clientHeight,
        clientTopInset: collapsed.clientTopInset,
        dpi: collapsed.dpi,
      };
      requireCondition(collapsed.visible && collapsed.topmost,
        "native_capsule_window_style_invalid");
      // Tao 0.35 keeps WS_CAPTION for top-level undecorated windows and
      // removes the caption through WM_NCCALCSIZE. Windows 11 may retain a
      // one-DIP shadow inset; inspect the actual client top, not that flag.
      requireCondition(
        collapsed.clientTopInset >= 0 && collapsed.clientTopInset <= Math.ceil(collapsed.dpi / 96) + 1,
        "native_capsule_native_caption_present",
      );
      requireCondition(
        Math.abs(collapsed.clientWidth * 96 / collapsed.dpi - 220) <= 4 &&
          Math.abs(collapsed.clientHeight * 96 / collapsed.dpi - 56) <= 4,
        "native_capsule_collapsed_size_invalid",
      );
      await focus(capsule, "capsule");
      await capsule.locator(".capsule-toggle").click();
      await capsule.locator(".capsule-editor textarea").waitFor({ state: "visible" });
      const expanded = await windowInfo("capsule");
      report.summary.expandedWindow = {
        clientWidth: expanded.clientWidth,
        clientHeight: expanded.clientHeight,
        clientTopInset: expanded.clientTopInset,
        dpi: expanded.dpi,
      };
      requireCondition(
        Math.abs(expanded.clientWidth * 96 / expanded.dpi - 420) <= 4 &&
          Math.abs(expanded.clientHeight * 96 / expanded.dpi - 360) <= 4 &&
          expanded.clientTopInset >= 0 && expanded.clientTopInset <= Math.ceil(expanded.dpi / 96) + 1,
        "native_capsule_expanded_size_invalid",
      );
      await native("Drag", "capsule");
      const moved = await windowInfo("capsule");
      requireCondition(
        Math.abs(moved.x - expanded.x) >= 20 && Math.abs(moved.y - expanded.y) >= 10 &&
          moved.clientWidth === expanded.clientWidth && moved.clientHeight === expanded.clientHeight,
        "native_capsule_drag_did_not_move_window",
      );
      return { windowLabelsVerified: 2, topmost: true, borderless: true, dragMovedWindow: true };
    });

    await step("enter-and-collapse-preserve-unsaved-draft", async () => {
      const untilNextDay = await capsule.evaluate(() => {
        const now = new Date();
        const nextDay = new Date(now);
        nextDay.setDate(now.getDate() + 1);
        nextDay.setHours(0, 0, 0, 0);
        return nextDay.getTime() - now.getTime();
      });
      if (untilNextDay < 45_000) await delay(untilNextDay + 1000);
      await focus(capsule, "capsule");
      await capsule.locator(".capsule-editor input").fill(notes[0].name);
      const editor = capsule.locator(".capsule-editor textarea");
      await editor.fill("Synthetic first line");
      await editor.press("Enter");
      await capsule.keyboard.insertText("Synthetic second line");
      requireCondition(await editor.inputValue() === notes[0].content, "native_capsule_enter_not_newline");
      requireCondition((await snapshot(main, capsule)).nodeCount === 0, "native_capsule_enter_submitted");
      requireCondition(await capsule.locator(".capsule-header button").last().isDisabled(),
        "native_capsule_draft_hide_not_blocked");
      await capsule.locator(".capsule-toggle").click();
      await capsule.locator(".capsule-editor textarea").waitFor({ state: "detached" });
      requireCondition((await snapshot(main, capsule)).nodeCount === 0, "native_capsule_collapse_submitted");
      await capsule.locator(".capsule-toggle").click();
      requireCondition(await editor.inputValue() === notes[0].content, "native_capsule_collapse_lost_draft");
      return { ordinaryEnterSaved: false, collapseSaved: false, draftPreserved: true };
    });

    await step("ctrl-enter-plus-native-blur-commits-once", async () => {
      await capsule.locator(".capsule-editor textarea").press("Control+Enter");
      await focus(main, "main");
      const saved = await poll(async () => {
        const value = await snapshot(main, capsule);
        return value?.captureCount === 1 ? value : false;
      }, "native_capsule_first_note_not_saved");
      requireCondition(
        saved.nodeCount === 2 && saved.dayCount === 1 && saved.referenceCount === 1 &&
          saved.activeCanvasId === initialCanvasId && saved.notes[0].count === 1 &&
          saved.notes[0].contentMatches && saved.notes[0].captured && saved.notes[0].dayReference,
        "native_capsule_first_note_transaction_invalid",
      );
      dayIdentities = saved.dayIdentities;
      await poll(async () =>
        await capsule.locator(".capsule-status").getAttribute("data-state") === "saved" &&
          await capsule.locator(".capsule-editor textarea").inputValue() === "",
      "native_capsule_saved_receipt_not_applied");
      await poll(() => main.evaluate(() => ["Saved", "已保存"].includes(
        document.querySelector(".app-status-toast > span")?.textContent ?? "",
      )), "native_capsule_main_commit_not_applied");
      await main.locator(".app-status-close").click();
      return { captures: saved.captureCount, dates: saved.dayCount, nodes: saved.nodeCount };
    });

    await step("native-blur-reuses-date-node", async () => {
      await focus(capsule, "capsule");
      await capsule.locator(".capsule-editor input").fill(notes[1].name);
      await capsule.locator(".capsule-editor textarea").fill(notes[1].content);
      await focus(main, "main");
      requireCondition(!await capsule.evaluate(() => document.hasFocus()), "native_capsule_blur_not_native");
      const saved = await poll(async () => {
        const value = await snapshot(main, capsule);
        return value?.captureCount === 2 ? value : false;
      }, "native_capsule_blur_note_not_saved");
      requireCondition(
        saved.nodeCount === 3 && saved.dayCount === 1 && saved.referenceCount === 2 &&
          saved.dayIdentities === dayIdentities && saved.notes.every((note) =>
            note.count === 1 && note.contentMatches && note.captured && note.dayReference),
        "native_capsule_date_reuse_invalid",
      );
      await poll(() => main.evaluate(() => ["Saved", "已保存"].includes(
        document.querySelector(".app-status-toast > span")?.textContent ?? "",
      )), "native_capsule_main_commit_not_applied");
      return { captures: saved.captureCount, dates: saved.dayCount, references: saved.referenceCount };
    });

    await step("single-undo-removes-one-capture", async () => {
      await focus(main, "main");
      await main.keyboard.press("Control+z");
      const undone = await poll(async () => {
        const value = await snapshot(main, capsule);
        return value?.captureCount === 1 ? value : false;
      }, "native_capsule_single_undo_failed");
      requireCondition(
        undone.nodeCount === 2 && undone.dayCount === 1 && undone.referenceCount === 1 &&
          undone.dayIdentities === dayIdentities && undone.notes[0].count === 1 &&
          undone.notes[1].count === 0,
        "native_capsule_undo_transaction_invalid",
      );
      return { capturesAfterOneUndo: undone.captureCount, datesRetained: undone.dayCount };
    });

    await step("capsule-sensitive-commands-rejected", async () => {
      const context = await readyContext(capsule);
      const rejected = await capsule.evaluate(async ({ ownerId }) => {
        const requests = [
          ["read_workspace_file", { ownerId, slot: "primary" }],
          ["unlock_workspace", { password: "Synthetic native smoke password only" }],
          ["restart_application", {}],
        ];
        const results = [];
        for (const [command, parameters] of requests) {
          try {
            await window.__TAURI_INTERNALS__.invoke(command, parameters);
            results.push(false);
          } catch (error) {
            results.push(error === "capsule_command_forbidden");
          }
        }
        return results;
      }, { ownerId: context.ownerId });
      requireCondition(rejected.length === 3 && rejected.every(Boolean), "native_capsule_command_isolation_failed");
      assertChildAlive();
      return { forbiddenCommandsRejected: rejected.length };
    });

    const syntheticPassword = "native capsule test phrase 2026";
    await step("enable-encryption-with-synthetic-master-password", async () => {
      const before = await readyContext(capsule);
      await focus(main, "main");
      await main.getByTestId("settings-navigation").click();
      await main.getByTestId("settings-tab-dataSecurity").click();
      await main.locator("#settings-panel-dataSecurity .security-settings-actions > button.primary-button").click();
      await main.locator("#workspace-security-password").fill(syntheticPassword);
      await main.locator("#workspace-security-password-confirmation").fill(syntheticPassword);
      await main.locator(".security-dialog-form button[type=submit]").click();
      await main.locator("#workspace-security-password").waitFor({ state: "detached", timeout: 45_000 });
      const current = await readyContext(capsule);
      const security = await invoke(main, "inspect_workspace_security");
      requireCondition(
        current.encrypted === true && current.ownerId !== before.ownerId &&
          security.encrypted === true && security.locked === false && security.systemUnlockEnabled === false,
        "native_capsule_encryption_owner_not_renewed",
      );
      requireCondition((await snapshot(main, capsule)).captureCount === 1,
        "native_capsule_encryption_changed_workspace");
      return { encrypted: true, newOwnerReady: true, systemQuickUnlockEnabled: false };
    });

    for (const [action, name] of [
      ["ManualLock", "encrypted-main-lock-revokes-capsule"],
      ["SessionLock", "session-lock-notification-clears-draft"],
      ["Suspend", "suspend-notification-clears-draft"],
    ]) {
      await step(name, async () => {
        const oldContext = await readyContext(capsule);
        requireCondition(oldContext.encrypted === true, "native_capsule_lock_requires_encryption");
        await focus(capsule, "capsule");
        if (await capsule.locator(".capsule-editor textarea").count() === 0) {
          await capsule.locator(".capsule-toggle").click();
          await capsule.locator(".capsule-editor textarea").waitFor({ state: "visible" });
        }
        await capsule.locator(".capsule-editor textarea").fill("Synthetic unsaved notification draft");
        // Keep native focus in the capsule so clicking Lock cannot accidentally
        // turn this unsaved draft into a blur submission before revocation.
        if (action === "ManualLock") await invoke(main, "lock_workspace");
        else await native(action, "main");
        await main.locator("#workspace-unlock-password").waitFor({ state: "visible" });
        await poll(async () => {
          const editor = capsule.locator(".capsule-editor textarea");
          const state = await invoke(capsule, "inspect_capsule");
          return state.ready === false && await editor.count() === 0;
        }, "native_capsule_notification_retained_draft");
        const oldReadRejected = await main.evaluate(async ({ ownerId }) => {
          try {
            await window.__TAURI_INTERNALS__.invoke("read_workspace_file", { ownerId, slot: "primary" });
            return false;
          } catch { return true; }
        }, { ownerId: oldContext.ownerId });
        const oldSubmitRejected = await capsule.evaluate(async ({ ownerId, contextId }) => {
          try {
            await window.__TAURI_INTERNALS__.invoke("submit_capsule_note", {
              ownerId,
              contextId,
              input: {
                nodeId: "77777777-7777-4777-8777-777777777777",
                name: "Synthetic rejected locked request",
                content: "Synthetic rejected locked content",
                capturedAtMs: Date.now(),
                utcOffsetMinutes: -new Date().getTimezoneOffset(),
              },
            });
            return false;
          } catch { return true; }
        }, { ownerId: oldContext.ownerId, contextId: oldContext.contextId });
        requireCondition(oldReadRejected && oldSubmitRejected, "native_capsule_locked_authority_accepted");
        await focus(main, "main");
        await main.locator("#workspace-unlock-password").fill(syntheticPassword);
        await main.locator(".security-unlock-form button[type=submit]").click();
        await main.locator("#workspace-unlock-password").waitFor({ state: "detached", timeout: 45_000 });
        const unlocked = await readyContext(capsule);
        requireCondition(unlocked.ownerId !== oldContext.ownerId,
          "native_capsule_unlock_reused_old_owner");
        main = await pageFor("main");
        const unchanged = await snapshot(main, capsule);
        requireCondition(unchanged.captureCount === 1, "native_capsule_notification_saved_draft");
        requireCondition(await capsule.evaluate(() =>
          !document.body.textContent.includes("Synthetic unsaved notification draft")),
        "native_capsule_unlock_restored_old_draft");
        return {
          encrypted: true,
          mainLocked: true,
          capsuleInputRemoved: true,
          oldReadRejected,
          oldSubmitRejected,
          explicitPasswordUnlock: true,
          notificationInjected: action !== "ManualLock",
          manualLockViaMainNativeCommand: action === "ManualLock",
          operatingSystemActuallyLockedOrSuspended: false,
        };
      });
    }

    await step("capsule-close-hides-and-main-close-exits", async () => {
      await native("Close", "capsule");
      await poll(async () => !(await windowInfo("capsule")).visible, "native_capsule_close_did_not_hide");
      assertChildAlive();
      await focus(main, "main");
      await main.getByTestId("capsule-open").click();
      await poll(async () => (await windowInfo("capsule")).visible, "native_capsule_reopen_failed");
      await native("Close", "main");
      requireCondition(await waitForExit(30_000), "native_capsule_main_close_did_not_exit");
      requireCondition(report.summary.pageErrorCount === 0, "native_capsule_page_errors_detected");
      return { capsuleCloseOnlyHidWindow: true, mainCloseExitedSpawnedProcess: true };
    });
  } finally {
    // Only the tracked child may be closed/killed. Existing app-data directories
    // and WebView profiles are never deleted; the disposable runner owns them.
    if (child !== null && !childExited && !childSpawnFailed) {
      try {
        await native("Close", "main").catch(() => {});
        if (!await waitForExit(10_000)) {
          // Startup can fail before any native window exists. Retain the
          // original ChildProcess handle as the cleanup target even then;
          // never fall back to process-name or workspace-wide termination.
          child.kill();
          requireCondition(await waitForExit(10_000), "native_capsule_owned_process_cleanup_failed");
        }
      } catch {
        if (!childExited) {
          child.unref();
          report.tests.push({ name: "owned-process-cleanup", status: "failed", error: "native_capsule_owned_process_cleanup_failed" });
        }
      }
    }
    if (browser !== null) await browser.close().catch(() => {});
    report.summary.spawnedProcessExited = childExited;
    report.summary.spawnedProcessExitCode = typeof child?.exitCode === "number" ? child.exitCode : null;
    if (debugPolicyEnabled) {
      try {
        const disabled = await executeHelper(debugHelper, "Disable", ["-Port", String(port)]);
        requireCondition(disabled.disabled === true, "native_capsule_debug_cleanup_failed");
      } catch {
        report.tests.push({ name: "debug-policy-cleanup", status: "failed", error: "native_capsule_debug_cleanup_failed" });
      }
    }
  }
}

try {
  await run();
} catch (error) {
  report.error = error instanceof SmokeFailure ? error.code : "native_capsule_driver_failed";
}
report.summary.passed = report.tests.filter((test) => test.status === "passed").length;
report.summary.failed = report.tests.filter((test) => test.status === "failed").length;
report.status = report.error === undefined && report.summary.failed === 0 ? "passed" : "failed";
if (writeReport !== undefined) {
  try { await writeReport(); } catch {
    report.error = "native_capsule_report_write_failed";
    report.status = "failed";
  }
}
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.status === "passed" ? 0 : 1;

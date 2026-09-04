// The report boundary accepts fixed diagnostic codes, never helper text.
export const HELPER_TIMEOUT_MS = 20_000;
export const HELPER_PHASES = [
  "script_entered", "arguments_validated", "paths_resolved", "target_validated",
  "cdp_check_started", "interop_compile_started", "interop_compile_completed",
  "dpi_setup_started", "target_recheck_started", "window_inspect_started",
  "window_inspect_completed", "window_action_started", "window_action_completed",
  "window_reinspect_started", "response_ready",
];
export const HELPER_ERROR_CODES = [
  "ci_required", "action_failed", "action_invalid", "close_failed", "dpi_unavailable",
  "drag_not_observed", "executable_invalid", "executable_outside_release",
  "executable_reparse_point", "focus_failed", "geometry_unavailable", "grip_obscured",
  "input_failed", "known_folder_unavailable", "notification_failed",
  "pointer_outside_desktop", "port_invalid", "process_path_mismatch",
  "process_unavailable", "role_invalid", "target_required", "window_ambiguous",
  "window_unavailable", "debug_failed", "debug_invalid_action",
  "debug_invalid_executable", "debug_invalid_port", "debug_policy_busy",
  "debug_policy_exists", "debug_policy_not_owned", "debug_verify_failed",
].map((suffix) => `native_capsule_${suffix}`);
const actions = new Set([
  "Paths", "Inspect", "Focus", "Drag", "SessionLock", "Suspend", "Close", "CdpOwner", "Enable", "Disable",
]);
const phaseNames = new Set(HELPER_PHASES);
const helperErrors = new Set(HELPER_ERROR_CODES);
const processErrors = new Set(["ENOENT", "EACCES", "EPERM", "ENOMEM", "EAGAIN", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]);
const processSignals = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT"]);

export class CapsuleHelperFailure extends Error {
  constructor(code, diagnostic) {
    super(code);
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

// execFile/clock injection exercises timeout reporting without starting pwsh,
// compiling interop, launching an app, or accessing any desktop state.
export function executeNativeCapsuleHelper({ execFile, script, kind, role, action, executable, extra = [], clock = () => performance.now() }) {
  if (!actions.has(action) || !["window", "debug"].includes(kind) || !["main", "capture"].includes(role)) {
    return Promise.reject(new CapsuleHelperFailure("native_capsule_helper_arguments_invalid", null));
  }
  const startedAt = clock();
  const elapsed = () => Math.min(3_600_000, Math.max(0, Math.floor(clock() - startedAt)));
  const diagnostic = { kind, role, action, timeoutMs: HELPER_TIMEOUT_MS, spawnObserved: false,
    spawnElapsedMs: null, phases: [], durationMs: 0, budgetElapsed: false,
    killed: false, signal: null, exitCode: null, processError: null, helperError: null };
  let pendingLine = "";
  let discardLine = false;
  function acceptLine(line) {
    if (line.length > 512) return;
    try {
      const value = JSON.parse(line);
      if (value === null || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).length !== 2 || !phaseNames.has(value.phase) ||
          !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 3_600_000 ||
          diagnostic.phases.some((entry) => entry.phase === value.phase) ||
          value.elapsedMs < (diagnostic.phases.at(-1)?.helperElapsedMs ?? 0)) return;
      diagnostic.phases.push({ phase: value.phase, helperElapsedMs: value.elapsedMs, observedElapsedMs: elapsed() });
    } catch { /* Non-protocol stderr is discarded, including exception details. */ }
  }
  function acceptChunk(chunk) {
    for (const part of String(chunk).split(/(?<=\n)/)) {
      if (!discardLine && pendingLine.length + part.length <= 512) pendingLine += part;
      else { pendingLine = ""; discardLine = true; }
      if (part.endsWith("\n")) {
        if (!discardLine) acceptLine(pendingLine.trim());
        pendingLine = "";
        discardLine = false;
      }
    }
  }
  function complete(error, stdout, stderr) {
    diagnostic.durationMs = elapsed();
    // This is an observation, not a claim that the budget timer caused the exit.
    diagnostic.budgetElapsed = diagnostic.durationMs >= HELPER_TIMEOUT_MS;
    if (pendingLine.length > 0 && !discardLine) acceptLine(pendingLine.trim());
    pendingLine = "";
    if (error !== null) {
      diagnostic.killed = error.killed === true;
      diagnostic.signal = processSignals.has(error.signal) ? error.signal : error.signal == null ? null : "other";
      diagnostic.exitCode = Number.isSafeInteger(error.code) ? error.code : null;
      diagnostic.processError = typeof error.code === "string" ? processErrors.has(error.code) ? error.code : "other" : null;
      for (const line of `${stdout ?? ""}\n${stderr ?? ""}`.split(/\r?\n/)) {
        if (line.length > 512) continue;
        try {
          const value = JSON.parse(line);
          if (value !== null && Object.keys(value).length === 1 && helperErrors.has(value.error)) {
            diagnostic.helperError = value.error;
          }
        } catch { /* No arbitrary stdout/stderr may enter the report. */ }
      }
      return new CapsuleHelperFailure("native_capsule_helper_failed", diagnostic);
    }
    diagnostic.exitCode = 0;
    return null;
  }
  return new Promise((resolve, reject) => {
    try {
      const child = execFile("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script,
        "-Action", action, "-ExecutablePath", executable, ...extra], {
        windowsHide: true, timeout: HELPER_TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: "utf8",
      }, (error, stdout, stderr) => {
        const failure = complete(error, stdout, stderr);
        if (failure !== null) { reject(failure); return; }
        try { resolve({ response: JSON.parse(stdout.replace(/^\uFEFF/, "").trim()), diagnostic }); }
        catch { reject(new CapsuleHelperFailure("native_capsule_helper_response_invalid", diagnostic)); }
      });
      child.once("spawn", () => {
        diagnostic.spawnObserved = true;
        diagnostic.spawnElapsedMs = elapsed();
      });
      child.stderr?.on("data", acceptChunk);
    } catch (error) {
      reject(complete(error, "", ""));
    }
  });
}

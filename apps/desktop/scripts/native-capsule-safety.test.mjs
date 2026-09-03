import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const desktop = path.join(repository, "apps/desktop");
const tools = [
  {
    name: "native driver",
    executable: process.execPath,
    args: [path.join(desktop, "scripts/native-capsule-smoke.mjs"), "--executable", "not-a-real-executable"],
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

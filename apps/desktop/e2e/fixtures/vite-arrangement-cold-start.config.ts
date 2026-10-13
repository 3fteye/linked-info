import { defineConfig } from "vite";
import desktopConfig from "../../vite.config";

export default defineConfig(async (environment) => {
  const variant = process.env.LINKED_INFO_ARRANGEMENT_VARIANT;
  const cacheDir = process.env.LINKED_INFO_ARRANGEMENT_CACHE;
  const phaseDelay = process.env.LINKED_INFO_ARRANGEMENT_PHASE_DELAY ?? "";
  if (phaseDelay !== "" && (!["startup-delay", "worker-delay"].includes(phaseDelay) ||
    process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.env.RUNNER_OS !== "Windows" || variant !== "fixed")) {
    throw new Error("Phase delay requires an explicit hosted Windows experiment");
  }
  if ((variant !== "baseline" && variant !== "fixed") || !cacheDir) {
    throw new Error("Cold-start validation requires an explicit variant and cache directory");
  }
  const config = await (
    typeof desktopConfig === "function" ? desktopConfig(environment) : desktopConfig
  );
  return {
    ...config,
    cacheDir,
    plugins: [...(config.plugins ?? []), {
      name: "synthetic-cold-start-phase-delay",
      configureServer(server) {
        if (phaseDelay === "") return;
        const target = phaseDelay === "startup-delay" ? "/src/MainWorkspace.tsx" : "/src/canvasAutoLayout.worker.ts";
        let held = false;
        server.middlewares.use((request, response, next) => {
          let pathname;
          try { pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname; }
          catch { next(); return; }
          if (held || pathname !== target) { next(); return; }
          held = true;
          // Fixed marker only; no URL, request headers, body or exception text.
          process.stdout.write(`phase-hold=${phaseDelay}\n`);
          const timer = setTimeout(next, 8_000);
          timer.unref();
          response.once("close", () => clearTimeout(timer));
        });
      },
    }],
    optimizeDeps: {
      ...config.optimizeDeps,
      // This is the pre-fix configuration from main 3b7d3ed. Only this one
      // dependency declaration differs; production has no baseline switch.
      include: variant === "baseline" ? [] : config.optimizeDeps?.include,
    },
  };
});

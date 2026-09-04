import { defineConfig } from "vite";
import desktopConfig from "../../vite.config";

export default defineConfig(async (environment) => {
  const variant = process.env.LINKED_INFO_ARRANGEMENT_VARIANT;
  const cacheDir = process.env.LINKED_INFO_ARRANGEMENT_CACHE;
  if ((variant !== "baseline" && variant !== "fixed") || !cacheDir) {
    throw new Error("Cold-start validation requires an explicit variant and cache directory");
  }
  const config = await (
    typeof desktopConfig === "function" ? desktopConfig(environment) : desktopConfig
  );
  return {
    ...config,
    cacheDir,
    optimizeDeps: {
      ...config.optimizeDeps,
      // This is the pre-fix configuration from main 3b7d3ed. Only this one
      // dependency declaration differs; production has no baseline switch.
      include: variant === "baseline" ? [] : config.optimizeDeps?.include,
    },
  };
});

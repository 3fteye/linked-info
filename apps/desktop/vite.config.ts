import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // The arrangement worker is reached only after an explicit canvas action.
  // Pre-bundle its dependency before that action can trigger a full-page reload.
  optimizeDeps: {
    include: ["@dagrejs/dagre"],
  },
  build: {
    outDir: mode === "capture" ? "dist-capture" : "dist",
    rollupOptions: {
      // The normal build validates both entries; the capture package embeds
      // only its own entry and does not include the main workspace bundle.
      input: mode === "capture" ? "capture.html" : { main: "index.html", capture: "capture.html" },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

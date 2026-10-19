import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// Browser-preview audit: route Runtime to the MuMu adb-forward proxy when set.
const runtimeTarget = process.env.HAKUS_RUNTIME_TARGET || "http://127.0.0.1:48081";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Pin IPv4 so tauri's devUrl (127.0.0.1) never races against IPv6-only
    // localhost resolution (vite would otherwise bind ::1 on some hosts).
    host: host || "127.0.0.1",
    // Rust browser preview keeps Runtime calls same-origin. The packaged
    // Tauri/Android clients connect to the Runtime directly and do not use
    // this dev-server proxy.
    proxy: {
      "/v1": { target: runtimeTarget, changeOrigin: true, ws: true },
      "/api": { target: runtimeTarget, changeOrigin: true },
      "/health": { target: runtimeTarget, changeOrigin: true },
      "/ws": { target: runtimeTarget.replace("http", "ws"), changeOrigin: true, ws: true },
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));

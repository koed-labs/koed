import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

const port = Number(process.env.PORT ?? 5733);
const host = process.env.HOST?.trim() || "localhost";
const configuredAppVersion = process.env.APP_VERSION?.trim() || pkg.version;
const sourcemapEnv = process.env.KOED_WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.APP_VERSION": JSON.stringify(configuredAppVersion)
  },
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  server: {
    host,
    port,
    strictPort: true,
    hmr: {
      protocol: "ws",
      host
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap
  },
  test: {
    setupFiles: ["./src/test/setupReactAct.ts"]
  }
});

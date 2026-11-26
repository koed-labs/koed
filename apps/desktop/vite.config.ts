import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { assertKoedReleaseVersion } from "../../packages/koed/release-version.mjs";

const desktopPackage = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
) as { version?: unknown };
const desktopVersion = assertKoedReleaseVersion(
  desktopPackage.version,
  "Desktop package.json"
);
const desktopMetadataAssets = (): Plugin => ({
  name: "koed-desktop-metadata",
  generateBundle() {
    this.emitFile({
      type: "asset" as const,
      fileName: "koed-release-version.json",
      source: `${JSON.stringify({ version: desktopVersion }, null, 2)}\n`
    });
    this.emitFile({
      type: "asset",
      fileName: "licenses/kin-engine.txt",
      source: readFileSync(
        new URL("../LICENSE", import.meta.resolve("@koed-labs/kin-engine"))
      )
    });
  }
});

export default defineConfig(({ mode }) => ({
  plugins: [desktopMetadataAssets(), react(), tailwindcss()],
  define: {
    __KOED_DESKTOP_VERSION__: JSON.stringify(desktopVersion)
  },
  base: "./",
  root: ".",
  optimizeDeps: { exclude: ["@koed-labs/kin-engine"] },
  build: {
    // Kin mesh requests use the app's own origin under the renderer CSP.
    assetsInlineLimit: (file) => (file.endsWith(".glb") ? false : undefined),
    outDir:
      mode === "validation" || mode === "v1-validation"
        ? "dist-validation"
        : "dist",
    emptyOutDir: true,
    rollupOptions: {
      input:
        mode === "v1-validation"
          ? { v1: resolve(import.meta.dirname, "v1-validation.html") }
          : mode === "validation"
            ? {
                browserValidation: resolve(
                  import.meta.dirname,
                  "browser-validation.html"
                )
              }
            : { app: resolve(import.meta.dirname, "index.html") }
    }
  },
  test: {
    setupFiles: ["../../scripts/vitest-react-setup.mjs"],
    alias: {
      "@koed-labs/mcp-server/managed-conversation-command-types": resolve(
        import.meta.dirname,
        "../../packages/mcp-server/src/managed-conversation-command-types.ts"
      )
    },
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    testTimeout: 15_000
  }
}));

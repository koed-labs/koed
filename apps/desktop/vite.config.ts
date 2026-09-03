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
const releaseVersionAsset = (): Plugin => ({
  name: "koed-release-version",
  generateBundle() {
    this.emitFile({
      type: "asset" as const,
      fileName: "koed-release-version.json",
      source: `${JSON.stringify({ version: desktopVersion }, null, 2)}\n`
    });
  }
});

export default defineConfig({
  plugins: [releaseVersionAsset(), react(), tailwindcss()],
  define: {
    __KOED_DESKTOP_VERSION__: JSON.stringify(desktopVersion)
  },
  base: "./",
  root: ".",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve(import.meta.dirname, "index.html"),
        browserValidation: resolve(
          import.meta.dirname,
          "browser-validation.html"
        )
      }
    }
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    testTimeout: 15_000
  }
});

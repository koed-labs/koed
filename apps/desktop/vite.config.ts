import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"]
  }
});

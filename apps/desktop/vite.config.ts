import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
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
  }
});

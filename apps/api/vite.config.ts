import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "src/browser-approval"),
  base: "/browser-approval/",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "dist/browser-approval"),
    emptyOutDir: true,
    sourcemap: false,
    assetsDir: "assets"
  }
});

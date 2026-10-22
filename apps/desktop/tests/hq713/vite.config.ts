import { defineConfig, mergeConfig } from "vite";
import base from "../../vite.config.js";
import { resolve } from "node:path";
const output = process.env.KOED_HQ713_DESKTOP_BUILD;
if (!output)
  throw new Error("HQ Desktop proof requires an owned build directory");
const config = mergeConfig(
  base,
  defineConfig({ build: { outDir: output, emptyOutDir: true } })
);
// Replace inherited entry points: this proof loads only the new HQ entry.
config.build!.rollupOptions!.input = {
  app: resolve(import.meta.dirname, "renderer.html")
};
export default config;

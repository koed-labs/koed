import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolveHistoryBrowserViteEnv } from "./env-config";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  ...resolveHistoryBrowserViteEnv(mode)
}));

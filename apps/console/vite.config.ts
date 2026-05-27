import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolveConsoleViteEnv } from "./env-config";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  ...resolveConsoleViteEnv(mode)
}));

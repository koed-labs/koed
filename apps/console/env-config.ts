import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, type UserConfig } from "vite";

const appDir = dirname(fileURLToPath(import.meta.url));

const intValue = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const resolveConsoleViteEnv = (mode: string): UserConfig => {
  const loaded = loadEnv(mode, appDir, "");
  const env = { ...loaded, ...process.env };
  const port = intValue(env.WEB_PORT, 5173);

  return {
    server: { port },
    preview: { port }
  };
};

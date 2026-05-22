import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const allowedHosts = (process.env.WEB_ALLOWED_HOSTS ?? "studio")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    allowedHosts
  },
  preview: {
    port: Number(process.env.WEB_PORT ?? 5173),
    allowedHosts
  }
});

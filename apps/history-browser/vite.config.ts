import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.HISTORY_WEB_PORT ?? 5174)
  },
  preview: {
    port: Number(process.env.HISTORY_WEB_PORT ?? 5174)
  }
});

import { buildServer } from "./server.js";
import { requireEnv } from "@koed/shared";

if (process.env.NODE_ENV === "production") {
  requireEnv([
    "DATABASE_URL",
    "REDIS_URL",
    "DATA_ENCRYPTION_KEY",
    "API_TOKEN_PEPPER",
    "EMBEDDING_SERVICE_TOKEN",
    "CORS_ORIGINS"
  ]);
}

const host = process.env.API_HOST ?? "0.0.0.0";
const port = Number(process.env.API_PORT ?? "3000");

const app = await buildServer();

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

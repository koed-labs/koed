import { loadApiEnv, resolveApiEnv } from "./env-config.js";

loadApiEnv();

const { buildServer } = await import("./server.js");
const { host, port } = resolveApiEnv();

const app = await buildServer();

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

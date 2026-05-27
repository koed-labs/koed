import { loadApiEnv, resolveApiEnv } from "./env-config.js";

loadApiEnv();

const { buildServer } = await import("./server/index.js");
const { host, port } = resolveApiEnv();

const app = await buildServer();

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(
    {
      event: {
        name: "api.listen.failed",
        category: "lifecycle"
      },
      err: error
    },
    "api listen failed"
  );
  process.exit(1);
}

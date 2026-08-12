#!/usr/bin/env node
import { startLocalAiRuntime } from "./local-runtime-server.js";
import { logger } from "./logger.js";

const runtime = await startLocalAiRuntime();
let stopping = false;

const stop = async (exitCode: number) => {
  if (stopping) return;
  stopping = true;
  logger.info("Koed local AI runtime shutting down");
  await runtime.close();
  process.exit(exitCode);
};

process.once("SIGINT", () => void stop(130));
process.once("SIGTERM", () => void stop(143));

await new Promise(() => undefined);

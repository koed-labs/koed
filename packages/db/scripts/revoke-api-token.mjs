#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatRevokeApiTokenResult,
  formatCliError,
  loadRootEnv,
  revokeApiTokenBootstrap,
  revokeHelpText,
  UsageError
} from "../../../scripts/api-token-bootstrap-lib.mjs";
import { createApiTokenScriptRepo } from "./api-token-repo.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = resolve(packageDir, "../..");

loadRootEnv(rootDir, process.env);

const repo = createApiTokenScriptRepo(process.env.DATABASE_URL);

try {
  if (
    process.argv.slice(2).includes("--help") ||
    process.argv.slice(2).includes("-h")
  ) {
    process.stdout.write(revokeHelpText);
    process.exit(0);
  }

  const result = await revokeApiTokenBootstrap({
    repo,
    environment: process.env,
    argv: process.argv.slice(2)
  });
  console.log(formatRevokeApiTokenResult(result));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    console.error(formatCliError(error));
    process.exitCode = 1;
  }
} finally {
  await repo.close().catch(() => {});
}

#!/usr/bin/env node
import { runHostedBackupCommand } from "./hosted-backup-lib.mjs";

try {
  await runHostedBackupCommand();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

#!/usr/bin/env node
import {
  createDbPool,
  createEncryptedPayloadRepository
} from "../packages/db/dist/index.js";
import { createEnvelopeEncryptionProviderFromEnvironment } from "../packages/shared/dist/index.js";
import { loadRootEnv } from "./api-token-bootstrap-lib.mjs";

const usage = `Usage: pnpm hosted:encryption-rewrap [options]

Rewrap encrypted_field_payloads DEKs with the configured envelope provider.

Options:
  --owner-user-id <uuid>    Limit to one owner user.
  --source-table <table>    Limit to one encrypted source table.
  --source-column <column>  Limit to one encrypted source column.
  --batch-size <n>          Rows to process per database batch. Default 100, max 500.
  --force                   Rewrap matching rows even when key_version is current.
  --json                    Print machine-readable JSON.
  --help                    Show this help.
`;

const readFlagValue = (argv, index, flag) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.\n\n${usage}`);
  }
  return value;
};

const parseArgs = (argv) => {
  const parsed = {
    ownerUserId: undefined,
    sourceTable: undefined,
    sourceColumn: undefined,
    batchSize: undefined,
    force: false,
    json: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--force") {
      parsed.force = true;
      continue;
    }
    if (arg === "--owner-user-id") {
      parsed.ownerUserId = readFlagValue(argv, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--owner-user-id=")) {
      parsed.ownerUserId = arg.slice("--owner-user-id=".length).trim();
      continue;
    }
    if (arg === "--source-table") {
      parsed.sourceTable = readFlagValue(argv, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--source-table=")) {
      parsed.sourceTable = arg.slice("--source-table=".length).trim();
      continue;
    }
    if (arg === "--source-column") {
      parsed.sourceColumn = readFlagValue(argv, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--source-column=")) {
      parsed.sourceColumn = arg.slice("--source-column=".length).trim();
      continue;
    }
    if (arg === "--batch-size") {
      parsed.batchSize = Number.parseInt(readFlagValue(argv, index, arg), 10);
      index += 1;
      continue;
    }
    if (arg.startsWith("--batch-size=")) {
      parsed.batchSize = Number.parseInt(arg.slice("--batch-size=".length), 10);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage}`);
  }

  if (
    parsed.batchSize !== undefined &&
    (!Number.isInteger(parsed.batchSize) || parsed.batchSize <= 0)
  ) {
    throw new Error(`--batch-size must be a positive integer.\n\n${usage}`);
  }
  return parsed;
};

loadRootEnv(process.cwd(), process.env);

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

if (args.help) {
  process.stdout.write(usage);
  process.exit(0);
}

let pool;
try {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
  }
  const provider = createEnvelopeEncryptionProviderFromEnvironment({
    required: true
  });
  if (!provider?.rewrap) {
    throw new Error(
      `Envelope provider ${provider?.mode ?? "unknown"} does not support rewrap.`
    );
  }
  pool = createDbPool();
  const repository = createEncryptedPayloadRepository(pool);
  const aggregate = {
    processedRows: 0,
    rewrappedRows: 0,
    failedRows: 0,
    batches: 0,
    done: false,
    nextCursorId: null
  };
  let afterId;
  do {
    const result = await repository.rewrapEncryptedFieldBatch(provider, {
      ownerUserId: args.ownerUserId,
      sourceTable: args.sourceTable,
      sourceColumn: args.sourceColumn,
      batchSize: args.batchSize,
      force: args.force,
      afterId
    });
    aggregate.processedRows += result.processedRows;
    aggregate.rewrappedRows += result.rewrappedRows;
    aggregate.failedRows += result.failedRows;
    aggregate.batches += 1;
    aggregate.done = result.done;
    aggregate.nextCursorId = result.nextCursorId;
    afterId = result.nextCursorId ?? undefined;
  } while (!aggregate.done && afterId);
  const report = {
    providerMode: provider.mode,
    keyId: provider.keyId,
    keyVersion: provider.keyVersion,
    ...aggregate
  };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `Provider: ${report.providerMode}`,
        `Key: ${report.keyId} v${report.keyVersion}`,
        `Processed: ${report.processedRows}`,
        `Rewrapped: ${report.rewrappedRows}`,
        `Failed: ${report.failedRows}`,
        `Batches: ${report.batches}`,
        `Done: ${report.done ? "yes" : "no"}`
      ].join("\n") + "\n"
    );
  }
  process.exitCode = aggregate.failedRows > 0 ? 1 : 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool?.end();
}

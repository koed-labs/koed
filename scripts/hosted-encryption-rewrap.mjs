#!/usr/bin/env node
import {
  createDbPool,
  createMemorySourceRepository
} from "../packages/db/dist/index.js";
import {
  createEnvelopeEncryptionProviderFromEnvironment,
  createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment
} from "../packages/shared/dist/index.js";
import { loadRootEnv } from "./api-token-bootstrap-lib.mjs";

const usage = `Usage: pnpm hosted:encryption-rewrap [options]

Rewrap encrypted-field and Shared Memory representation DEKs with the configured
Team/general and owner-private envelope providers.

Options:
  --owner-user-id <uuid>    Limit to one owner user.
  --team-id <uuid>          Limit Team-scoped payloads to one Team.
  --source-table <table>    Limit to one encrypted source table.
  --source-column <column>  Limit to one encrypted source column.
  --batch-size <n>          Rows to process per database batch. Default 100, max 500.
  --force                   Rewrap matching rows even when key_version is current.
  --dry-run                 Count matching rows without changing wrapped DEKs.
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
    teamId: undefined,
    sourceTable: undefined,
    sourceColumn: undefined,
    batchSize: undefined,
    force: false,
    dryRun: false,
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
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--owner-user-id") {
      parsed.ownerUserId = readFlagValue(argv, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg === "--team-id") {
      parsed.teamId = readFlagValue(argv, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--team-id=")) {
      parsed.teamId = arg.slice("--team-id=".length).trim();
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
  const ownerPrivateProvider =
    createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment({
      required: true
    });
  if (!provider?.rewrap) {
    throw new Error(
      `Envelope provider ${provider?.mode ?? "unknown"} does not support rewrap.`
    );
  }
  if (!ownerPrivateProvider?.rewrap) {
    throw new Error(
      `Owner-private envelope provider ${ownerPrivateProvider?.mode ?? "unknown"} does not support rewrap.`
    );
  }
  if (provider.keyId === ownerPrivateProvider.keyId) {
    throw new Error(
      "Owner-private replica envelope encryption must use a distinct key from the Team/general provider."
    );
  }
  pool = createDbPool();
  const repository = createMemorySourceRepository(pool, {
    envelopeEncryptionProvider: provider,
    ownerPrivateReplicaEnvelopeEncryptionProvider: ownerPrivateProvider
  });
  const emptyAggregate = () => ({
    processedRows: 0,
    rewrappedRows: 0,
    wouldRewrapRows: 0,
    failedRows: 0,
    batches: 0,
    done: false,
    nextCursorId: null
  });
  const runBatches = async (runBatch) => {
    const aggregate = emptyAggregate();
    let afterId;
    do {
      const result = await runBatch(afterId);
      aggregate.processedRows += result.processedRows;
      aggregate.rewrappedRows += result.rewrappedRows;
      aggregate.wouldRewrapRows += result.wouldRewrapRows;
      aggregate.failedRows += result.failedRows;
      aggregate.batches += 1;
      aggregate.done = result.done;
      aggregate.nextCursorId = result.nextCursorId;
      afterId = result.nextCursorId ?? undefined;
    } while (!aggregate.done && afterId);
    return aggregate;
  };
  const teamGeneralFields = await runBatches((afterId) =>
    repository.rewrapEncryptedFieldBatch(provider, {
      ownerUserId: args.ownerUserId,
      teamId: args.teamId,
      sourceTable: args.sourceTable,
      sourceColumn: args.sourceColumn,
      batchSize: args.batchSize,
      force: args.force,
      dryRun: args.dryRun,
      afterId
    })
  );
  const ownerPrivateFields = await runBatches((afterId) =>
    repository.rewrapEncryptedFieldBatch(ownerPrivateProvider, {
      ownerUserId: args.ownerUserId,
      teamId: args.teamId,
      sourceTable: args.sourceTable,
      sourceColumn: args.sourceColumn,
      batchSize: args.batchSize,
      force: args.force,
      dryRun: args.dryRun,
      afterId
    })
  );
  const teamRepresentations =
    args.ownerUserId || args.sourceTable || args.sourceColumn
      ? { ...emptyAggregate(), done: true }
      : await runBatches((afterId) =>
          repository.rewrapTeamRepresentationChunkBatch(provider, {
            teamId: args.teamId,
            batchSize: args.batchSize,
            force: args.force,
            dryRun: args.dryRun,
            afterId
          })
        );
  const aggregates = {
    teamGeneralFields,
    ownerPrivateFields,
    teamRepresentations
  };
  const totals = Object.values(aggregates).reduce(
    (total, value) => ({
      processedRows: total.processedRows + value.processedRows,
      rewrappedRows: total.rewrappedRows + value.rewrappedRows,
      wouldRewrapRows: total.wouldRewrapRows + value.wouldRewrapRows,
      failedRows: total.failedRows + value.failedRows,
      batches: total.batches + value.batches
    }),
    {
      processedRows: 0,
      rewrappedRows: 0,
      wouldRewrapRows: 0,
      failedRows: 0,
      batches: 0
    }
  );
  const report = {
    providers: {
      teamGeneral: {
        mode: provider.mode,
        keyId: provider.keyId,
        keyVersion: provider.keyVersion
      },
      ownerPrivate: {
        mode: ownerPrivateProvider.mode,
        keyId: ownerPrivateProvider.keyId,
        keyVersion: ownerPrivateProvider.keyVersion
      }
    },
    families: aggregates,
    dryRun: args.dryRun,
    ...totals,
    done: Object.values(aggregates).every((value) => value.done)
  };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `Team/general provider: ${report.providers.teamGeneral.mode} ${report.providers.teamGeneral.keyId} v${report.providers.teamGeneral.keyVersion}`,
        `Owner-private provider: ${report.providers.ownerPrivate.mode} ${report.providers.ownerPrivate.keyId} v${report.providers.ownerPrivate.keyVersion}`,
        `Processed: ${report.processedRows}`,
        `Would rewrap: ${report.wouldRewrapRows}`,
        `Rewrapped: ${report.rewrappedRows}`,
        `Failed: ${report.failedRows}`,
        `Batches: ${report.batches}`,
        `Done: ${report.done ? "yes" : "no"}`
      ].join("\n") + "\n"
    );
  }
  process.exitCode = report.failedRows > 0 ? 1 : 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool?.end();
}

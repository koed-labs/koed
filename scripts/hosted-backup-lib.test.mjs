import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createHostedBackup,
  parseHostedBackupArgs,
  redactDatabaseUrl,
  restoreSmokeHostedBackup,
  runHostedBackupCommand,
  verifyHostedBackup
} from "./hosted-backup-lib.mjs";

const fixedNow = new Date("2026-07-03T10:00:00.000Z");
const backupEncryptionKey = Buffer.alloc(32, 21).toString("base64");
const digest = (character) => character.repeat(64);

const collaborationTransportSummary = {
  version: 1,
  state: "non_empty",
  families: {
    threads: { count: 2, sha256: digest("1") },
    messages: { count: 3, sha256: digest("2") },
    encryptedCompanions: { count: 11, sha256: digest("3") },
    outbox: { count: 5, sha256: digest("4") }
  },
  keyReferences: { count: 1, sha256: digest("5") },
  relationships: {
    brokenMessageThreadLinks: 0,
    brokenCompanionSourceLinks: 0,
    brokenOutboxThreadLinks: 0,
    brokenOutboxMessageLinks: 0,
    brokenOutboxResourceLinks: 0,
    brokenCompanionAuthorizationBindings: 0
  }
};

const emptyCollaborationTransportSummary = {
  version: 1,
  state: "empty",
  families: {
    threads: { count: 0, sha256: digest("a") },
    messages: { count: 0, sha256: digest("a") },
    encryptedCompanions: { count: 0, sha256: digest("a") },
    outbox: { count: 0, sha256: digest("a") }
  },
  keyReferences: { count: 0, sha256: digest("a") },
  relationships: {
    brokenMessageThreadLinks: 0,
    brokenCompanionSourceLinks: 0,
    brokenOutboxThreadLinks: 0,
    brokenOutboxMessageLinks: 0,
    brokenOutboxResourceLinks: 0,
    brokenCompanionAuthorizationBindings: 0
  }
};

const collaborationProbeForBackup = (backup) => ({
  threadCount: 1,
  messageCount: 1,
  outboxCount: 2,
  companions: backup.manifest.collaborationRestoreSentinel.companions.map(
    (companion) => ({
      id: companion.id,
      ownerUserId: backup.manifest.collaborationRestoreSentinel.ownerUserId,
      sourceTable: companion.sourceTable,
      sourceId: companion.sourceId,
      sourceColumn: companion.sourceColumn,
      plaintextContentType: companion.plaintextContentType,
      envelope: companion.envelope
    })
  )
});

const postgresScriptForCall = (args, options = {}) => {
  const fileArgIndex = args.indexOf("--file");
  const scriptPath =
    options.stdinFile ?? (fileArgIndex >= 0 ? args[fileArgIndex + 1] : null);
  return scriptPath ? fs.readFileSync(scriptPath, "utf8") : "";
};

const withCollaborationTransportSummaries = (
  run,
  summaries = [collaborationTransportSummary],
  onSummary = () => undefined
) => {
  let summaryIndex = 0;
  return async (command, args, options = {}) => {
    const isPsql =
      path.basename(command).includes("psql") || args.includes("psql");
    const script = isPsql ? postgresScriptForCall(args, options) : "";
    if (script.includes("collaboration transport summary")) {
      const summary = summaries[Math.min(summaryIndex, summaries.length - 1)];
      summaryIndex += 1;
      onSummary({ command, args, options, script, summary, summaryIndex });
      return { stdout: `${JSON.stringify(summary)}\n`, stderr: "" };
    }
    return run(command, args, options);
  };
};

test("parseHostedBackupArgs parses create, verify, and restore-smoke", () => {
  assert.deepEqual(
    parseHostedBackupArgs([
      "create",
      "--output-dir",
      "/backups",
      "--database-url",
      "postgres://user:pass@db/koed",
      "--status-path",
      "/status.json",
      "--allow-plaintext"
    ]),
    {
      command: "create",
      outputDir: "/backups",
      databaseUrl: "postgres://user:pass@db/koed",
      statusPath: "/status.json",
      allowPlaintext: true
    }
  );
  assert.deepEqual(
    parseHostedBackupArgs(["verify", "--backup-file", "a.dump"]),
    {
      command: "verify",
      backupFile: "a.dump"
    }
  );
  assert.deepEqual(
    parseHostedBackupArgs(["--", "verify", "--backup-file", "a.dump"]),
    {
      command: "verify",
      backupFile: "a.dump"
    }
  );
  assert.deepEqual(
    parseHostedBackupArgs([
      "restore-smoke",
      "--backup-file",
      "a.dump",
      "--target-database-url",
      "postgres://target:pass@db/koed_restore",
      "--confirm-restore-smoke-target",
      "koed_restore"
    ]),
    {
      command: "restore-smoke",
      backupFile: "a.dump",
      targetDatabaseUrl: "postgres://target:pass@db/koed_restore",
      confirmRestoreSmokeTarget: "koed_restore"
    }
  );
});

test("hosted backup command fails before create when pg_dump major does not match target server", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "koed-backup-version-"));
  await assert.rejects(
    runHostedBackupCommand({
      argv: ["create", "--output-dir", dir],
      env: {
        DATABASE_URL: "postgres://koed:secret@localhost:5432/koed",
        PSQL_BIN: "psql16",
        PG_DUMP_BIN: "pg_dump17",
        API_DATA_ENCRYPTION_KEY: backupEncryptionKey
      },
      run: async (command) => {
        if (command === "psql16") {
          return { stdout: "160014\n", stderr: "" };
        }
        if (command === "pg_dump17") {
          return { stdout: "pg_dump (PostgreSQL) 17.10\n", stderr: "" };
        }
        throw new Error(`unexpected command: ${command}`);
      },
      stdout: { write() {} }
    }),
    /pg_dump major version 17 does not match target Postgres major version 16/
  );
});

test("redactDatabaseUrl removes username and password", () => {
  assert.equal(
    redactDatabaseUrl("postgres://user:secret@localhost:5432/koed"),
    "postgres://redacted:redacted@localhost:5432/koed"
  );
});

test("createHostedBackup writes dump manifest and redacted status", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "koed-backup-test-"));
  const statusPath = path.join(dir, "status.json");
  const calls = [];
  const operations = [];
  const result = await createHostedBackup({
    now: fixedNow,
    env: {
      DATABASE_URL: "postgres://koed:secret@localhost:5432/koed",
      PG_DUMP_BIN: "pg_dump_test",
      API_DATA_ENCRYPTION_KEY: backupEncryptionKey
    },
    options: {
      command: "create",
      outputDir: dir,
      statusPath
    },
    run: withCollaborationTransportSummaries(
      async (command, args) => {
        operations.push("pg_dump");
        calls.push({ command, args });
        const fileIndex = args.indexOf("--file") + 1;
        fs.writeFileSync(args[fileIndex], "backup-bytes");
        return { stdout: "", stderr: "" };
      },
      [collaborationTransportSummary],
      ({ script }) => {
        operations.push("summary");
        assert.match(script, /from collaboration_threads/);
        assert.match(script, /from collaboration_messages/);
        assert.match(script, /from encrypted_field_payloads/);
        assert.match(script, /from collaboration_outbox/);
        assert.match(script, /payload\.provider_mode/);
        assert.match(script, /broken_companion_authorization_bindings/);
        assert.doesNotMatch(script, /decrypt/i);
        assert.doesNotMatch(
          script,
          /\b(insert|update|delete|truncate|alter|drop|create)\b/i
        );
      }
    )
  });

  assert.deepEqual(operations, ["summary", "pg_dump", "summary"]);
  assert.equal(calls[0].command, "pg_dump_test");
  assert.deepEqual(calls[0].args.slice(0, 5), [
    "--format=custom",
    "--no-owner",
    "--no-acl",
    "--file",
    result.backupFile.replace(/\.enc$/, "")
  ]);
  assert.equal(result.manifest.databaseUrl.includes("secret"), false);
  assert.equal(result.manifest.backupFile, "koed-20260703T100000Z.dump.enc");
  assert.equal(result.manifest.encrypted, true);
  assert.equal(
    result.manifest.encryption.envelope.providerMode,
    "local_test_key"
  );
  assert.equal(
    result.manifest.encryption.envelope.keyId.startsWith("local_test_key:"),
    true
  );
  assert.equal(result.manifest.schemaVersion, 4);
  assert.deepEqual(
    result.manifest.collaborationTransportSummary,
    collaborationTransportSummary
  );
  assert.equal(result.manifest.collaborationRestoreSentinel.version, 1);
  assert.equal(
    result.manifest.collaborationRestoreSentinel.companions.length,
    5
  );
  assert.equal(result.manifest.collaborationRestoreSentinel.outbox.length, 2);
  assert.equal(
    result.manifest.collaborationRestoreSentinel.companions.every(
      (companion) =>
        companion.envelope.keyId ===
          result.manifest.encryption.envelope.keyId &&
        companion.envelope.ciphertext.length > 0 &&
        companion.plaintext === undefined
    ),
    true
  );
  assert.equal(JSON.stringify(result.manifest).includes("backup-bytes"), false);
  assert.equal(JSON.stringify(result.manifest).includes("restoreProof"), false);
  assert.equal(
    JSON.stringify(result.manifest).includes("hosted_restore_smoke"),
    false
  );
  assert.equal(fs.existsSync(result.backupFile.replace(/\.enc$/, "")), false);
  assert.equal(fs.existsSync(result.manifestPath), true);
  const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  assert.equal(status.status, "ok");
  assert.equal(status.provider, "pg_dump");
  assert.equal(status.backupFile, "koed-20260703T100000Z.dump.enc");
  assert.equal(status.encrypted, true);
  assert.equal(status.encryptionProviderMode, "local_test_key");
  assert.equal(status.lastSuccessfulAt, fixedNow.toISOString());
  assert.equal(JSON.stringify(status).includes("secret"), false);
  assert.equal(
    JSON.stringify(status).includes(
      result.manifest.collaborationRestoreSentinel.ownerUserId
    ),
    false
  );
});

test("hosted backup uses Docker Compose Postgres tools for local Compose databases", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "koed-backup-compose-"));
  const sourceUrl = "postgres://koed:secret@localhost:15432/koed";
  const restoreUrl = "postgres://koed:secret@localhost:15432/koed_restore";
  const env = {
    DATABASE_URL: sourceUrl,
    POSTGRES_DB: "koed",
    POSTGRES_USER: "koed",
    POSTGRES_PASSWORD: "secret",
    POSTGRES_HOST_PORT: "15432",
    API_DATA_ENCRYPTION_KEY: backupEncryptionKey
  };
  const calls = [];
  let backup;
  const run = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === "docker" && args.includes("ps")) {
      return { stdout: "compose-postgres-container\n", stderr: "" };
    }
    if (
      command === "docker" &&
      args.includes("exec") &&
      args.includes("pg_dump")
    ) {
      fs.writeFileSync(options.stdoutFile, "compose-backup-bytes");
      return { stdout: "", stderr: "" };
    }
    if (
      command === "docker" &&
      args.includes("exec") &&
      args.includes("pg_restore") &&
      args.includes("--list")
    ) {
      assert.equal(
        fs.readFileSync(options.stdinFile, "utf8"),
        "compose-backup-bytes"
      );
      return { stdout: "TABLE public.users\n", stderr: "" };
    }
    if (
      command === "docker" &&
      args.includes("exec") &&
      args.includes("pg_restore")
    ) {
      assert.equal(
        fs.readFileSync(options.stdinFile, "utf8"),
        "compose-backup-bytes"
      );
      assert(
        args.includes("postgres://koed:secret@127.0.0.1:5432/koed_restore")
      );
      return { stdout: "", stderr: "" };
    }
    if (
      command === "docker" &&
      args.includes("exec") &&
      args.includes("psql")
    ) {
      const script = postgresScriptForCall(args, options);
      if (script.includes("restore sentinel seed")) {
        assert.match(script, /insert into collaboration_threads/);
        assert.match(script, /insert into collaboration_thread_audiences/);
        assert.match(
          script,
          /insert into collaboration_thread_audience_members/
        );
        assert.match(script, /insert into collaboration_messages/);
        assert.match(script, /provenance_marker, audience_version/);
        assert.match(script, /insert into encrypted_field_payloads/);
        assert.match(script, /insert into collaboration_outbox/);
        return { stdout: "", stderr: "" };
      }
      if (script.includes("restore sentinel probe")) {
        assert.match(script, /thread\.personal_owner_user_id/);
        return {
          stdout: `${JSON.stringify(collaborationProbeForBackup(backup))}\n`,
          stderr: ""
        };
      }
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  const runWithSummaries = withCollaborationTransportSummaries(run);

  backup = await createHostedBackup({
    now: fixedNow,
    env,
    options: { command: "create", outputDir: dir },
    run: runWithSummaries
  });
  const verified = await verifyHostedBackup({
    now: fixedNow,
    env,
    options: { command: "verify", backupFile: backup.backupFile },
    run: runWithSummaries
  });
  const restored = await restoreSmokeHostedBackup({
    now: fixedNow,
    env,
    options: {
      command: "restore-smoke",
      backupFile: backup.backupFile,
      targetDatabaseUrl: restoreUrl,
      confirmRestoreSmokeTarget: "koed_restore"
    },
    run: runWithSummaries
  });

  assert.equal(verified.ok, true);
  assert.equal(restored.status.restoreSmoke, "passed");
  assert.equal(restored.status.collaborationTransportIntegrity, "passed");
  assert.equal(
    calls.some(
      (call) => call.command === "docker" && call.args.includes("pg_dump")
    ),
    true
  );
  assert.equal(
    calls.some(
      (call) => call.command === "pg_dump_test" || call.command === "pg_dump"
    ),
    false
  );
});

test("createHostedBackup requires archive encryption unless explicitly allowed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "koed-backup-required-"));
  await assert.rejects(
    createHostedBackup({
      now: fixedNow,
      env: {
        DATABASE_URL: "postgres://koed:secret@localhost:5432/koed",
        PG_DUMP_BIN: "pg_dump_test"
      },
      options: {
        command: "create",
        outputDir: dir
      },
      run: async () => ({ stdout: "", stderr: "" })
    }),
    /envelope encryption provider is required/
  );
});

test("createHostedBackup supports KMS-backed archive encryption", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "koed-backup-kms-"));
  const originalFetch = globalThis.fetch;
  const kmsCalls = [];
  globalThis.fetch = async (url, init) => {
    kmsCalls.push({ url: String(url), init });
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/wrap")) {
      return new Response(JSON.stringify({ ciphertext: body.dek }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (String(url).endsWith("/unwrap")) {
      return new Response(JSON.stringify({ dek: body.wrappedDek.ciphertext }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("unexpected", { status: 500 });
  };
  try {
    const env = {
      DATABASE_URL: "postgres://koed:secret@localhost:5432/koed",
      PG_DUMP_BIN: "pg_dump_test",
      PG_RESTORE_BIN: "pg_restore_test",
      API_ENVELOPE_ENCRYPTION_PROVIDER: "managed_kms",
      MANAGED_KMS_KEY_ID: "managed-kms:test",
      MANAGED_KMS_KEY_VERSION: "7",
      MANAGED_KMS_ENDPOINT_URL: "http://localhost:8999/kms/",
      MANAGED_KMS_AUTH_TOKEN: "kms-secret-token"
    };
    const backup = await createHostedBackup({
      now: fixedNow,
      env,
      options: { command: "create", outputDir: dir },
      run: withCollaborationTransportSummaries(async (_command, args) => {
        fs.writeFileSync(
          args[args.indexOf("--file") + 1],
          "sensitive archive bytes"
        );
        return { stdout: "", stderr: "" };
      })
    });
    const verified = await verifyHostedBackup({
      now: fixedNow,
      env,
      options: { command: "verify", backupFile: backup.backupFile },
      run: async (_command, args) => {
        assert.equal(
          fs.readFileSync(args[1], "utf8"),
          "sensitive archive bytes"
        );
        return { stdout: "TABLE public.users\n" };
      }
    });

    assert.equal(
      backup.manifest.encryption.envelope.providerMode,
      "managed_kms"
    );
    assert.equal(backup.manifest.encryption.envelope.keyVersion, 7);
    assert.equal(
      backup.manifest.encryption.envelope.ciphertext,
      "[external-backup-archive]"
    );
    assert.equal(
      JSON.stringify(backup.manifest).includes("sensitive archive bytes"),
      false
    );
    assert.equal(fs.existsSync(backup.backupFile.replace(/\.enc$/, "")), false);
    assert.equal(verified.ok, true);
    assert.deepEqual(
      kmsCalls.map((call) => new URL(call.url).pathname),
      [
        "/kms/wrap",
        "/kms/wrap",
        "/kms/wrap",
        "/kms/wrap",
        "/kms/wrap",
        "/kms/wrap",
        "/kms/unwrap"
      ]
    );
    assert.equal(
      JSON.stringify(backup.manifest).includes("kms-secret-token"),
      false
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createHostedBackup removes plaintext dump when encryption fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "koed-backup-cleanup-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  try {
    await assert.rejects(
      createHostedBackup({
        now: fixedNow,
        env: {
          DATABASE_URL: "postgres://koed:secret@localhost:5432/koed",
          PG_DUMP_BIN: "pg_dump_test",
          API_ENVELOPE_ENCRYPTION_PROVIDER: "managed_kms",
          MANAGED_KMS_KEY_ID: "managed-kms:test",
          MANAGED_KMS_KEY_VERSION: "1",
          MANAGED_KMS_ENDPOINT_URL: "http://localhost:8999/kms/",
          MANAGED_KMS_AUTH_TOKEN: "kms-secret-token"
        },
        options: { command: "create", outputDir: dir },
        run: withCollaborationTransportSummaries(async (_command, args) => {
          fs.writeFileSync(args[args.indexOf("--file") + 1], "backup");
          return { stdout: "", stderr: "" };
        })
      }),
      /backup KMS wrap failed/
    );
    assert.deepEqual(
      fs.readdirSync(dir).filter((entry) => entry.endsWith(".dump")),
      []
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createHostedBackup keeps plaintext mode explicit for local checks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "koed-backup-plain-"));
  const result = await createHostedBackup({
    now: fixedNow,
    env: {
      DATABASE_URL: "postgres://koed:secret@localhost:5432/koed",
      PG_DUMP_BIN: "pg_dump_test"
    },
    options: {
      command: "create",
      outputDir: dir,
      allowPlaintext: true
    },
    run: withCollaborationTransportSummaries(async (_command, args) => {
      fs.writeFileSync(args[args.indexOf("--file") + 1], "backup-bytes");
      return { stdout: "", stderr: "" };
    })
  });

  assert.equal(result.manifest.encrypted, false);
  assert.equal(path.basename(result.backupFile), "koed-20260703T100000Z.dump");
});

test("createHostedBackup fails closed when collaboration data changes during pg_dump", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "koed-backup-collaboration-change-")
  );
  const changedSummary = structuredClone(collaborationTransportSummary);
  changedSummary.families.messages.sha256 = digest("6");
  let dumpRan = false;
  await assert.rejects(
    createHostedBackup({
      now: fixedNow,
      env: {
        DATABASE_URL: "postgres://koed:secret@localhost:5432/koed",
        PG_DUMP_BIN: "pg_dump_test"
      },
      options: {
        command: "create",
        outputDir: dir,
        allowPlaintext: true
      },
      run: withCollaborationTransportSummaries(
        async (_command, args) => {
          dumpRan = true;
          fs.writeFileSync(args[args.indexOf("--file") + 1], "unstable-backup");
          return { stdout: "", stderr: "" };
        },
        [collaborationTransportSummary, changedSummary]
      )
    }),
    /Collaboration data changed while pg_dump was running/
  );
  assert.equal(dumpRan, true);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("createHostedBackup fails closed on broken collaboration authorization bindings", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "koed-backup-collaboration-links-")
  );
  const brokenSummary = structuredClone(collaborationTransportSummary);
  brokenSummary.relationships.brokenCompanionAuthorizationBindings = 1;
  let dumpRan = false;
  await assert.rejects(
    createHostedBackup({
      now: fixedNow,
      env: {
        DATABASE_URL: "postgres://koed:secret@localhost:5432/koed",
        PG_DUMP_BIN: "pg_dump_test"
      },
      options: { command: "create", outputDir: dir, allowPlaintext: true },
      run: withCollaborationTransportSummaries(async () => {
        dumpRan = true;
        return { stdout: "", stderr: "" };
      }, [brokenSummary])
    }),
    /summary contains broken encrypted or outbox links/
  );
  assert.equal(dumpRan, false);
});

test("verifyHostedBackup checks pg_restore list and writes status", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "koed-backup-verify-"));
  const statusPath = path.join(dir, "status.json");
  const backup = await createHostedBackup({
    now: fixedNow,
    env: {
      DATABASE_URL: "postgres://koed:secret@localhost:5432/koed",
      PG_DUMP_BIN: "pg_dump_test",
      API_DATA_ENCRYPTION_KEY: backupEncryptionKey
    },
    options: { command: "create", outputDir: dir },
    run: withCollaborationTransportSummaries(async (_command, args) => {
      fs.writeFileSync(args[args.indexOf("--file") + 1], "backup");
      return { stdout: "", stderr: "" };
    })
  });
  const calls = [];
  const result = await verifyHostedBackup({
    now: fixedNow,
    env: {
      PG_RESTORE_BIN: "pg_restore_test",
      API_DATA_ENCRYPTION_KEY: backupEncryptionKey
    },
    options: { command: "verify", backupFile: backup.backupFile, statusPath },
    run: async (command, args) => {
      calls.push({ command, args });
      assert.notEqual(args[1], backup.backupFile);
      assert.equal(fs.readFileSync(args[1], "utf8"), "backup");
      return { stdout: "TABLE public.users\n; comment\nTABLE public.teams\n" };
    }
  });

  assert.equal(calls[0].command, "pg_restore_test");
  assert.equal(calls[0].args[0], "--list");
  assert.equal(result.ok, true);
  const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  assert.equal(status.provider, "pg_restore");
  assert.equal(status.encrypted, true);
  assert.equal(status.encryptionProviderMode, "local_test_key");
  assert.equal(status.entries, 2);
});

test("restoreSmokeHostedBackup restores into an explicit target database", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "koed-backup-restore-"));
  const backup = await createHostedBackup({
    now: fixedNow,
    env: {
      DATABASE_URL: "postgres://koed:secret@localhost:5432/koed",
      PG_DUMP_BIN: "pg_dump_test",
      API_DATA_ENCRYPTION_KEY: backupEncryptionKey
    },
    options: { command: "create", outputDir: dir },
    run: withCollaborationTransportSummaries(async (_command, args) => {
      fs.writeFileSync(args[args.indexOf("--file") + 1], "backup");
      return { stdout: "", stderr: "" };
    })
  });
  const calls = [];
  const result = await restoreSmokeHostedBackup({
    now: fixedNow,
    env: {
      PG_RESTORE_BIN: "pg_restore_test",
      PSQL_BIN: "psql_test",
      API_DATA_ENCRYPTION_KEY: backupEncryptionKey
    },
    options: {
      command: "restore-smoke",
      backupFile: backup.backupFile,
      targetDatabaseUrl: "postgres://restore:secret@localhost/koed_restore",
      confirmRestoreSmokeTarget: "koed_restore"
    },
    run: withCollaborationTransportSummaries(
      async (command, args, runOptions = {}) => {
        calls.push({ command, args, runOptions });
        if (command === "pg_restore_test") {
          assert.equal(fs.readFileSync(args.at(-1), "utf8"), "backup");
          return { stdout: "", stderr: "" };
        }
        assert.equal(command, "psql_test");
        const script = postgresScriptForCall(args, runOptions);
        if (script.includes("restore sentinel seed")) {
          assert.equal(script.includes("super-secret"), false);
          assert.equal(script.includes("restoreProof"), false);
          assert.equal(script.includes("hosted_restore_smoke"), false);
          assert.match(script, /insert into collaboration_threads/);
          assert.match(script, /insert into collaboration_messages/);
          assert.match(script, /insert into encrypted_field_payloads/);
          assert.match(script, /insert into collaboration_outbox/);
          return { stdout: "", stderr: "" };
        }
        assert.match(script, /thread\.personal_owner_user_id/);
        return {
          stdout: `${JSON.stringify(collaborationProbeForBackup(backup))}\n`,
          stderr: ""
        };
      }
    )
  });

  const restoreCall = calls.find((call) => call.command === "pg_restore_test");
  assert.deepEqual(restoreCall.args, [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-acl",
    "--dbname",
    "postgres://restore:secret@localhost/koed_restore",
    restoreCall.args.at(-1)
  ]);
  assert.equal(calls.filter((call) => call.command === "psql_test").length, 2);
  assert.equal(result.status.restoreSmoke, "passed");
  assert.equal(result.status.collaborationTransportIntegrity, "passed");
  assert.equal(result.status.collaborationTransportSourceState, "non_empty");
  assert.equal(result.status.collaborationSyntheticIntegrity, "passed");
  assert.equal(result.status.collaborationSentinelVersion, 1);
  assert.equal(result.status.encrypted, true);
  assert.equal(result.status.targetDatabaseUrl.includes("secret"), false);
});

test("restoreSmokeHostedBackup handles an empty collaboration source explicitly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "koed-backup-empty-"));
  const backup = await createHostedBackup({
    now: fixedNow,
    env: {
      DATABASE_URL: "postgres://koed:secret@localhost:5432/koed",
      PG_DUMP_BIN: "pg_dump_test",
      API_DATA_ENCRYPTION_KEY: backupEncryptionKey
    },
    options: { command: "create", outputDir: dir },
    run: withCollaborationTransportSummaries(
      async (_command, args) => {
        fs.writeFileSync(args[args.indexOf("--file") + 1], "empty-backup");
        return { stdout: "", stderr: "" };
      },
      [emptyCollaborationTransportSummary]
    )
  });
  const result = await restoreSmokeHostedBackup({
    now: fixedNow,
    env: {
      PG_RESTORE_BIN: "pg_restore_test",
      PSQL_BIN: "psql_test",
      API_DATA_ENCRYPTION_KEY: backupEncryptionKey
    },
    options: {
      command: "restore-smoke",
      backupFile: backup.backupFile,
      targetDatabaseUrl: "postgres://restore:secret@localhost/koed_restore",
      confirmRestoreSmokeTarget: "koed_restore"
    },
    run: withCollaborationTransportSummaries(
      async (command, args, runOptions = {}) => {
        if (command === "pg_restore_test") {
          return { stdout: "", stderr: "" };
        }
        const script = postgresScriptForCall(args, runOptions);
        return script.includes("restore sentinel probe")
          ? {
              stdout: `${JSON.stringify(collaborationProbeForBackup(backup))}\n`,
              stderr: ""
            }
          : { stdout: "", stderr: "" };
      },
      [emptyCollaborationTransportSummary]
    )
  });

  assert.equal(result.status.collaborationTransportIntegrity, "passed");
  assert.equal(result.status.collaborationTransportSourceState, "empty");
  assert.equal(result.status.collaborationSyntheticIntegrity, "passed");
});

test("restoreSmokeHostedBackup fails closed when restored collaboration transport differs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "koed-backup-mismatch-"));
  const backup = await createHostedBackup({
    now: fixedNow,
    env: {
      DATABASE_URL: "postgres://koed:secret@localhost:5432/koed",
      PG_DUMP_BIN: "pg_dump_test"
    },
    options: { command: "create", outputDir: dir, allowPlaintext: true },
    run: withCollaborationTransportSummaries(async (_command, args) => {
      fs.writeFileSync(args[args.indexOf("--file") + 1], "plain-backup");
      return { stdout: "", stderr: "" };
    })
  });
  const restoredSummary = structuredClone(collaborationTransportSummary);
  restoredSummary.families.messages.count -= 1;
  restoredSummary.families.messages.sha256 = digest("7");
  let syntheticSeedRan = false;

  await assert.rejects(
    restoreSmokeHostedBackup({
      now: fixedNow,
      env: { PG_RESTORE_BIN: "pg_restore_test", PSQL_BIN: "psql_test" },
      options: {
        command: "restore-smoke",
        backupFile: backup.backupFile,
        targetDatabaseUrl: "postgres://restore:secret@localhost/koed_restore",
        confirmRestoreSmokeTarget: "koed_restore",
        allowPlaintext: true
      },
      run: withCollaborationTransportSummaries(
        async (command, args, runOptions = {}) => {
          if (command === "pg_restore_test") {
            return { stdout: "", stderr: "" };
          }
          syntheticSeedRan ||= postgresScriptForCall(args, runOptions).includes(
            "restore sentinel seed"
          );
          return { stdout: "", stderr: "" };
        },
        [restoredSummary]
      )
    }),
    /Restored collaboration data does not match the source backup summary/
  );
  assert.equal(syntheticSeedRan, false);
});

test("restoreSmokeHostedBackup refuses destructive restore without explicit scratch confirmation", async () => {
  await assert.rejects(
    restoreSmokeHostedBackup({
      now: fixedNow,
      env: { PG_RESTORE_BIN: "pg_restore_test" },
      options: {
        command: "restore-smoke",
        backupFile: "/tmp/backup.dump",
        targetDatabaseUrl: "postgres://restore:secret@localhost/koed_restore"
      },
      run: async () => {
        throw new Error("pg_restore should not run");
      }
    }),
    /--confirm-restore-smoke-target koed_restore/
  );

  await assert.rejects(
    restoreSmokeHostedBackup({
      now: fixedNow,
      env: { PG_RESTORE_BIN: "pg_restore_test" },
      options: {
        command: "restore-smoke",
        backupFile: "/tmp/backup.dump",
        targetDatabaseUrl: "postgres://restore:secret@localhost/koed",
        confirmRestoreSmokeTarget: "koed"
      },
      run: async () => {
        throw new Error("pg_restore should not run");
      }
    }),
    /dedicated scratch\/restore\/smoke\/test database/
  );
});

test("restoreSmokeHostedBackup fails closed when encrypted archive key is unavailable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "koed-backup-keyless-"));
  const backup = await createHostedBackup({
    now: fixedNow,
    env: {
      DATABASE_URL: "postgres://koed:secret@localhost:5432/koed",
      PG_DUMP_BIN: "pg_dump_test",
      API_DATA_ENCRYPTION_KEY: backupEncryptionKey
    },
    options: { command: "create", outputDir: dir },
    run: withCollaborationTransportSummaries(async (_command, args) => {
      fs.writeFileSync(args[args.indexOf("--file") + 1], "backup");
      return { stdout: "", stderr: "" };
    })
  });

  const calls = [];
  await assert.rejects(
    restoreSmokeHostedBackup({
      now: fixedNow,
      env: { PG_RESTORE_BIN: "pg_restore_test" },
      options: {
        command: "restore-smoke",
        backupFile: backup.backupFile,
        targetDatabaseUrl: "postgres://restore:secret@localhost/koed_restore",
        confirmRestoreSmokeTarget: "koed_restore",
        allowPlaintext: true
      },
      run: async (...args) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      }
    }),
    /envelope encryption provider is required/
  );
  assert.equal(calls.length, 0);
});

test("restoreSmokeHostedBackup fails closed when a collaboration key reference is not retained", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "koed-backup-collaboration-keyless-")
  );
  const backup = await createHostedBackup({
    now: fixedNow,
    env: {
      DATABASE_URL: "postgres://koed:secret@localhost:5432/koed",
      PG_DUMP_BIN: "pg_dump_test",
      API_DATA_ENCRYPTION_KEY: backupEncryptionKey
    },
    options: { command: "create", outputDir: dir },
    run: withCollaborationTransportSummaries(async (_command, args) => {
      fs.writeFileSync(args[args.indexOf("--file") + 1], "backup");
      return { stdout: "", stderr: "" };
    })
  });
  backup.manifest.collaborationRestoreSentinel.companions[0].envelope.keyId =
    "local_test_key:missing-retained-key";
  fs.writeFileSync(
    backup.manifestPath,
    `${JSON.stringify(backup.manifest, null, 2)}\n`
  );

  const calls = [];
  await assert.rejects(
    restoreSmokeHostedBackup({
      now: fixedNow,
      env: {
        PG_RESTORE_BIN: "pg_restore_test",
        PSQL_BIN: "psql_test",
        API_DATA_ENCRYPTION_KEY: backupEncryptionKey
      },
      options: {
        command: "restore-smoke",
        backupFile: backup.backupFile,
        targetDatabaseUrl: "postgres://restore:secret@localhost/koed_restore",
        confirmRestoreSmokeTarget: "koed_restore"
      },
      run: withCollaborationTransportSummaries(
        async (command, args, runOptions = {}) => {
          calls.push(command);
          if (command === "pg_restore_test") {
            return { stdout: "", stderr: "" };
          }
          const script = postgresScriptForCall(args, runOptions);
          return script.includes("restore sentinel probe")
            ? {
                stdout: `${JSON.stringify(collaborationProbeForBackup(backup))}\n`,
                stderr: ""
              }
            : { stdout: "", stderr: "" };
        }
      )
    }),
    /key reference does not match the backup provider key/
  );
  assert.deepEqual(calls, ["pg_restore_test", "psql_test", "psql_test"]);
});

test("runHostedBackupCommand writes redacted failure status for restore errors", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "koed-backup-failure-"));
  const statusPath = path.join(dir, "status.json");
  const backup = await createHostedBackup({
    now: fixedNow,
    env: {
      DATABASE_URL: "postgres://koed:secret@localhost:5432/koed",
      PG_DUMP_BIN: "pg_dump_test",
      API_DATA_ENCRYPTION_KEY: backupEncryptionKey
    },
    options: { command: "create", outputDir: dir },
    run: withCollaborationTransportSummaries(async (_command, args) => {
      fs.writeFileSync(args[args.indexOf("--file") + 1], "backup");
      return { stdout: "", stderr: "" };
    })
  });

  fs.writeFileSync(
    statusPath,
    `${JSON.stringify({
      status: "ok",
      provider: "pg_dump",
      checkedAt: fixedNow.toISOString(),
      lastSuccessfulAt: fixedNow.toISOString()
    })}\n`
  );

  await assert.rejects(
    runHostedBackupCommand({
      now: fixedNow,
      argv: [
        "restore-smoke",
        "--backup-file",
        backup.backupFile,
        "--target-database-url",
        "postgres://restore:super-secret@localhost/koed_restore",
        "--confirm-restore-smoke-target",
        "koed_restore",
        "--status-path",
        statusPath
      ],
      env: {
        PG_RESTORE_BIN: "pg_restore_test",
        API_DATA_ENCRYPTION_KEY: backupEncryptionKey
      },
      run: async () => {
        throw new Error(
          "pg_restore failed for postgres://restore:super-secret@localhost/koed_restore"
        );
      },
      stdout: { write: () => undefined }
    }),
    /pg_restore failed/
  );

  const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  assert.equal(status.status, "error");
  assert.equal(status.provider, "pg_restore");
  assert.equal(status.operation, "restore-smoke");
  assert.equal(status.lastSuccessfulAt, fixedNow.toISOString());
  assert.equal(status.errorMessage.includes("super-secret"), false);
  assert.equal(status.errorMessage.includes("redacted"), true);
});

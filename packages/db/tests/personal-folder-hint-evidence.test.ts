import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  personalFolderHintEvidenceSchema,
  type RepositoryIdentity
} from "@koed-labs/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const options = {
  envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 94).toString("base64")
  )
};
const portable = {
  kind: "portable_repository",
  key: "gr_folder_hint",
  root: "/repo",
  branch: "main",
  reason: "origin",
  checkoutId: "checkout",
  originatingDeviceId: "device",
  selectedRemote: "origin",
  anchorDisplay: "example.test/repo"
} as const satisfies RepositoryIdentity;
const local = {
  ...portable,
  kind: "device_local_repository",
  reason: "local_fallback",
  selectedRemote: null,
  anchorDisplay: null
} as const satisfies RepositoryIdentity;
const unresolved = {
  ...local,
  kind: "unresolved",
  key: null,
  reason: "probe_failed"
} as const satisfies RepositoryIdentity;
const nonGit = {
  ...local,
  kind: "non_git_project",
  reason: "non_git"
} as const satisfies RepositoryIdentity;

describe.skipIf(!databaseUrl)("Folder hint evidence in PostgreSQL", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("reports known Git Anchors from effective identity without invalidating a mixed batch", async () => {
    const repo = createMemorySourceRepository(pool, options);
    const actor = {
      userId: (
        await repo.createUser({ email: `hint-${randomUUID()}@example.test` })
      ).id
    };
    const cases = [
      { automatic: null, override: null, known: false },
      { automatic: unresolved, override: null, known: false },
      { automatic: null, override: unresolved, known: false },
      { automatic: portable, override: unresolved, known: false },
      { automatic: portable, override: nonGit, known: false },
      { automatic: portable, override: null, known: true },
      { automatic: local, override: null, known: true },
      { automatic: unresolved, override: portable, known: true },
      { automatic: unresolved, override: local, known: true }
    ];
    const anchors = new Map<string, boolean>();
    for (const { automatic, override, known } of cases) {
      const session = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        ...(automatic ? { repositoryIdentity: automatic } : {})
      });
      if (override)
        await pool.query(
          "update sessions set repository_override_identity=$2 where id=$1",
          [session.id, override]
        );
      anchors.set(session.id, known);
    }
    const deleted = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID()
    });
    const invalidated = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID()
    });
    await pool.query(
      "update sessions set personal_deleted_at=now() where id=$1",
      [deleted.id]
    );
    await pool.query("update sessions set invalidated_at=now() where id=$1", [
      invalidated.id
    ]);

    const result = await repo.getPersonalFolderHintEvidence(actor, {
      sessionIds: [...anchors.keys(), deleted.id, invalidated.id]
    });
    const bySession = new Map(
      result.evidence.map((row) => [row.sessionId, row.gitAnchorKnown])
    );
    expect(bySession.get(anchors.keys().next().value!)).toBe(false);
    expect(personalFolderHintEvidenceSchema.parse(result).ownerUserId).toBe(
      actor.userId
    );
    expect(bySession).toEqual(anchors);
  });
});

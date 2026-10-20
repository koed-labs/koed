import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  createMemorySourceRepository,
  createWorkItemRepository,
  runDbMigrations
} from "@koed/db";
import type {
  SourceControlOperation,
  SourceControlRemote,
  SourceControlReviewRequest
} from "@koed/shared";
import {
  createWorkItemPrReconciler,
  workItemReviewRemoteMatches
} from "./pr-reconciliation.js";

const testUrl =
  process.env.KOED_HQ405_TEST_DATABASE_URL ??
  (process.env.CI ? process.env.DATABASE_URL : undefined);
const remote: SourceControlRemote = {
  remoteName: "origin",
  provider: "github",
  host: "github.com",
  transport: "https",
  locator: { namespace: "koed-labs", repository: "koed", project: null },
  remoteIdentityHash: "a".repeat(64),
  connectionId: randomUUID(),
  credentialGeneration: 1,
  connectionState: "connected",
  capabilities: ["review_request_read", "checks_read"]
};
const prUrl = "https://github.com/koed-labs/koed/pull/212";
const review: SourceControlReviewRequest = {
  id: "github:212",
  number: 212,
  title: "Update",
  state: "merged",
  draft: false,
  sourceBranch: "feature",
  targetBranch: "main",
  headObjectId: "b".repeat(40),
  author: "colleague",
  webUrl: prUrl,
  updatedAt: "2026-10-20T20:00:00Z"
};

describe("Work Item canonical PR binding", () => {
  it("requires exact provider repository, number, host and read capabilities", () => {
    const item = { prUrl, prProvider: "github.com", prNumber: 212 };
    expect(workItemReviewRemoteMatches(remote, item)).toBe(true);
    for (const url of [
      "https://github.com/elsewhere/koed/pull/212",
      "https://github.com/koed-labs/koed/pull/213",
      "https://github.com.evil.test/koed-labs/koed/pull/212",
      `${prUrl}?authority=override`,
      "https://github.com/koed-labs%2Fkoed/pull/212"
    ])
      expect(workItemReviewRemoteMatches(remote, { ...item, prUrl: url })).toBe(
        false
      );
    expect(
      workItemReviewRemoteMatches(
        { ...remote, capabilities: ["review_request_read"] },
        item
      )
    ).toBe(false);
    expect(
      workItemReviewRemoteMatches(
        { ...remote, connectionState: "revoked" },
        item
      )
    ).toBe(false);
  });
});

describe.skipIf(!testUrl)("Work Item trusted provider reconciliation", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let database: string;
  const owner = randomUUID();
  const other = randomUUID();
  const session = randomUUID();
  const logical = randomUUID();
  const execution = randomUUID();
  const deployment = randomUUID();
  const device = randomUUID();
  const runner = randomUUID();
  let project: string;
  let itemId: string;
  let repository: ReturnType<typeof createWorkItemRepository>;
  let state: SourceControlReviewRequest["state"];
  let mutate:
    | ((kind: SourceControlOperation["kind"]) => Promise<void>)
    | undefined;
  let reads: number;
  let headChanges: boolean;
  let ambiguous: boolean;
  const execute = vi.fn(
    async (_owner: string, operation: SourceControlOperation) => {
      await mutate?.(operation.kind);
      if (operation.kind === "remotes")
        return {
          kind: "remotes" as const,
          remotes: ambiguous
            ? [remote, { ...remote, connectionId: randomUUID() }]
            : [remote],
          headObjectId: review.headObjectId
        };
      if (operation.kind === "checks")
        return { kind: "checks" as const, checks: [] };
      if (operation.kind === "review_request") {
        reads += 1;
        return {
          kind: "review_request" as const,
          reviewRequest: {
            ...review,
            state,
            headObjectId:
              headChanges && reads > 1 ? "c".repeat(40) : review.headObjectId
          }
        };
      }
      throw new Error(`Unexpected provider mutation: ${operation.kind}`);
    }
  );
  const reconcile = () =>
    createWorkItemPrReconciler({
      workItems: repository,
      requireRepository: () => createMemorySourceRepository(pool),
      sourceControl: { execute },
      trustedRepository: (verifyTrustedTransition) =>
        createWorkItemRepository(pool, { verifyTrustedTransition })
    })(owner, project, itemId);
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    database = `hq405_reconcile_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${database}"`);
    const url = new URL(testUrl!);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await runDbMigrations(pool);
    repository = createWorkItemRepository(pool);
    await pool.query("insert into users(id,email) values ($1,$2),($3,$4)", [
      owner,
      `${owner}@example.test`,
      other,
      `${other}@example.test`
    ]);
    project = (
      await pool.query<{ id: string }>(
        "insert into projects(owner_user_id,name,key) values($1,'PR review','PR') returning id",
        [owner]
      )
    ).rows[0]!.id;
    await pool.query(
      "insert into sessions(id,logical_session_id,owner_user_id,source_runtime,capture_method) values($1,$2,$3,'codex','api')",
      [session, logical, owner]
    );
    await pool.query(
      `insert into managed_conversation_executions
      (id,owner_user_id,project_id,ai_client_instance_id,model,permission_mode,runner_kind,state,fencing_token_hash,runner_deployment_id,runner_device_id,runner_id,runner_lease_expires_at,logical_session_id,provider_thread_id)
      values($1,$2,$3,'codex','test','auto','local_device','quiesced',$4,$5,$6,$7,now()-interval '1 hour',$8,'provider-thread')`,
      [
        execution,
        owner,
        project,
        "a".repeat(64),
        deployment,
        device,
        runner,
        logical
      ]
    );
    await pool.query(
      `insert into managed_conversation_runtime_bindings
      (execution_id,owner_user_id,deployment_id,device_id,execution_generation,project_path,source_project_path,local_session_id,provider_thread_id,transcript_path,managed_home)
      values($1,$2,$3,$4,1,'/fixture','/fixture',$5,'provider-thread','/fixture/transcript','/fixture/home')`,
      [execution, owner, deployment, device, session]
    );
  }, 30000);
  beforeEach(async () => {
    state = "merged";
    mutate = undefined;
    reads = 0;
    headChanges = false;
    ambiguous = false;
    execute.mockClear();
    await pool.query(
      "update managed_conversation_executions set execution_generation=1 where id=$1",
      [execution]
    );
    await pool.query(
      "update sessions set personal_deleted_at=null, trashed_at=null where id=$1",
      [session]
    );
    const item = await repository.create(owner, project, {
      kind: "todo",
      title: "Review",
      goal: "Ship",
      origin: "manual",
      idempotencyKey: randomUUID()
    });
    itemId = item.id;
    await pool.query(
      "update project_work_items set status='review',execution_id=$2,pr_provider='github.com',pr_number=212,pr_url=$3,pr_state='open' where id=$1",
      [itemId, execution, prUrl]
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (admin && database)
      await admin.query(`drop database "${database}" with (force)`);
    await admin?.end();
  });
  it("moves a quiesced execution's item to Done only after provider merged reads, once", async () => {
    expect(await reconcile()).toMatchObject({
      status: "done",
      prState: "merged",
      version: 2
    });
    const count = execute.mock.calls.length;
    expect(await reconcile()).toMatchObject({ status: "done", version: 2 });
    expect(execute).toHaveBeenCalledTimes(count);
    expect(
      execute.mock.calls.every(([, operation]) =>
        ["remotes", "review_request", "checks"].includes(operation.kind)
      )
    ).toBe(true);
  });
  it("leaves an open PR In review and marks closed-unmerged Blocked", async () => {
    state = "open";
    expect(await reconcile()).toMatchObject({ status: "review", version: 1 });
    state = "closed";
    expect(await reconcile()).toMatchObject({
      status: "blocked",
      prState: "closed",
      version: 2
    });
  });
  it("rejects changed provider head and ambiguous accounts without mutating", async () => {
    headChanges = true;
    await expect(reconcile()).rejects.toThrow("PR changed");
    headChanges = false;
    ambiguous = true;
    await expect(reconcile()).rejects.toThrow("ambiguous");
    expect(await repository.getForRealtime(owner, itemId)).toMatchObject({
      status: "review",
      version: 1
    });
  });
  it("fences an execution generation changed during a provider read", async () => {
    mutate = async (kind) => {
      if (kind === "checks")
        await pool.query(
          "update managed_conversation_executions set execution_generation=2 where id=$1",
          [execution]
        );
    };
    await expect(reconcile()).rejects.toThrow("authority changed");
    expect(await repository.getForRealtime(owner, itemId)).toMatchObject({
      status: "review",
      version: 1
    });
  });
  it("fences Conversation deletion under the trusted transition transaction", async () => {
    mutate = async (kind) => {
      if (kind === "checks")
        await pool.query(
          "update sessions set personal_deleted_at=now() where id=$1",
          [session]
        );
    };
    await expect(reconcile()).rejects.toThrow("Conversation changed");
    expect(await repository.getForRealtime(owner, itemId)).toMatchObject({
      status: "review",
      version: 1
    });
  });
  it("rejects a concurrent Work Item edit and a foreign owner before transition", async () => {
    mutate = async (kind) => {
      if (kind === "checks")
        await pool.query(
          "update project_work_items set version=version+1 where id=$1",
          [itemId]
        );
    };
    await expect(reconcile()).rejects.toThrow("Work Item changed");
    const foreign = createWorkItemPrReconciler({
      workItems: repository,
      requireRepository: () => createMemorySourceRepository(pool),
      sourceControl: { execute },
      trustedRepository: (verifyTrustedTransition) =>
        createWorkItemRepository(pool, { verifyTrustedTransition })
    });
    execute.mockClear();
    await expect(foreign(other, project, itemId)).rejects.toThrow(
      "unavailable"
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

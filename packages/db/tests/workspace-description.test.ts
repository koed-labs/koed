import { randomUUID } from "node:crypto";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from "vitest";
import type pg from "pg";
import { createDbPool } from "../src/connection.js";
import { runDbMigrations } from "../src/migrate.js";
import { createMemorySourceRepository } from "../src/repository.js";

const databaseUrl = process.env.WORKSPACE_DESCRIPTION_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("encrypted Team Workspace descriptions", () => {
  let pool: pg.Pool;

  const provider = () =>
    createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 23).toString("base64")
    );

  const createOwnerAndTeam = async (
    encryptionProvider: EnvelopeEncryptionProvider = provider()
  ) => {
    const repository = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: encryptionProvider
    });
    const owner = await repository.createUser({
      email: `workspace-owner-${randomUUID()}@example.com`,
      displayName: "Workspace Owner"
    });
    const team = await repository.createTeam(
      { userId: owner.id },
      { name: `Workspace Team ${randomUUID()}` }
    );
    return { owner, repository, team };
  };

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  });

  afterEach(async () => {
    await pool.query("truncate table users, teams restart identity cascade");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("stores only a marker and decrypts after current Workspace authorization", async () => {
    const baseProvider = provider();
    const decrypt = vi.fn(baseProvider.decrypt.bind(baseProvider));
    const instrumentedProvider = {
      ...baseProvider,
      encrypt: baseProvider.encrypt.bind(baseProvider),
      decrypt,
      rewrap: baseProvider.rewrap?.bind(baseProvider)
    } satisfies EnvelopeEncryptionProvider;
    const { owner, repository, team } =
      await createOwnerAndTeam(instrumentedProvider);
    const description = "Résumé planning and delivery notes";

    const workspace = await repository.createTeamWorkspace(
      { userId: owner.id },
      {
        teamId: team.id,
        name: "  Product e\u0301ngineering  ",
        description: "  Re\u0301sume\u0301 planning and delivery notes  "
      }
    );

    expect(workspace).toMatchObject({
      teamId: team.id,
      name: "Product éngineering",
      description
    });
    const storedWorkspace = await pool.query<{
      description_marker: string | null;
      rendered: string;
    }>(
      `select description_marker, row_to_json(team_workspaces)::text as rendered
       from team_workspaces where id = $1`,
      [workspace!.id]
    );
    expect(storedWorkspace.rows[0]?.description_marker).toBe(
      "[koed encrypted team workspace description]"
    );
    expect(storedWorkspace.rows[0]?.rendered).not.toContain(description);

    const encrypted = await pool.query<{
      team_id: string;
      team_workspace_id: string;
      source_table: string;
      source_column: string;
      ciphertext: string;
      rendered: string;
    }>(
      `select team_id, team_workspace_id, source_table, source_column,
              ciphertext, row_to_json(encrypted_field_payloads)::text as rendered
       from encrypted_field_payloads
       where source_table = 'team_workspaces'
         and source_id = $1
         and source_column = 'description'
         and invalidated_at is null`,
      [workspace!.id]
    );
    expect(encrypted.rows).toHaveLength(1);
    expect(encrypted.rows[0]).toMatchObject({
      team_id: team.id,
      team_workspace_id: workspace!.id,
      source_table: "team_workspaces",
      source_column: "description"
    });
    expect(encrypted.rows[0]!.ciphertext).not.toContain(description);
    expect(encrypted.rows[0]!.rendered).not.toContain(description);

    const atomicCompanions = await pool.query<{
      owner_access: string;
      general_thread: string;
      workspace_audit: string;
      thread_audit: string;
      workspace_outbox: string;
      thread_outbox: string;
    }>(
      `select
         (select count(*) from team_workspace_access_grants
          where team_workspace_id = $1 and team_id = $2 and user_id = $3
            and access = 'write' and disabled_at is null)::text as owner_access,
         (select count(*) from collaboration_threads
          where team_workspace_id = $1 and team_id = $2
            and kind = 'workspace_channel' and system_key = 'workspace.general')::text as general_thread,
         (select count(*) from audit_events
          where action = 'team.workspace.created' and target_id = $1)::text as workspace_audit,
         (select count(*) from audit_events
          where action = 'team.thread.created'
            and metadata ->> 'teamWorkspaceId' = $1::text)::text as thread_audit,
         (select count(*) from collaboration_outbox
          where family = 'workspace_lifecycle_access'
            and resource_type = 'team_workspace' and resource_id = $1)::text as workspace_outbox,
         (select count(*) from collaboration_outbox
          where family = 'thread_lifecycle'
            and team_workspace_id = $1 and resource_type = 'collaboration_thread')::text as thread_outbox`,
      [workspace!.id, team.id, owner.id]
    );
    expect(atomicCompanions.rows[0]).toEqual({
      owner_access: "1",
      general_thread: "1",
      workspace_audit: "1",
      thread_audit: "1",
      workspace_outbox: "1",
      thread_outbox: "1"
    });

    const listed = await repository.listTeamWorkspaces(
      { userId: owner.id },
      { teamId: team.id }
    );
    expect(listed?.find((item) => item.id === workspace!.id)?.description).toBe(
      description
    );
    const context = await repository.getTeamWorkspaceContext(
      { userId: owner.id },
      workspace!.id
    );
    expect(context?.teamWorkspace.description).toBe(description);

    const decryptsBeforeUnauthorizedRead = decrypt.mock.calls.length;
    const outsider = await repository.createUser({
      email: `workspace-outsider-${randomUUID()}@example.com`
    });
    await pool.query(
      `insert into team_memberships (
         team_id, user_id, role, status, accepted_at
       ) values ($1, $2, 'member', 'enabled', now())`,
      [team.id, outsider.id]
    );
    expect(
      await repository.listTeamWorkspaces(
        { userId: outsider.id },
        { teamId: team.id }
      )
    ).toEqual([]);
    expect(
      await repository.getTeamWorkspaceContext(
        { userId: outsider.id },
        workspace!.id
      )
    ).toBeNull();
    expect(decrypt).toHaveBeenCalledTimes(decryptsBeforeUnauthorizedRead);

    const rotated = await repository.rewrapEncryptedFieldBatch(
      instrumentedProvider,
      {
        sourceTable: "team_workspaces",
        sourceColumn: "description",
        force: true
      }
    );
    expect(rotated).toMatchObject({ processedRows: 1, rewrappedRows: 1 });
  });

  it("rolls back Workspace, access, channel, audit, outbox, and payload when encryption fails", async () => {
    const baseProvider = provider();
    const failingProvider = {
      ...baseProvider,
      encrypt: vi.fn(async () => {
        throw new Error("injected encryption failure");
      }),
      decrypt: baseProvider.decrypt.bind(baseProvider),
      rewrap: baseProvider.rewrap?.bind(baseProvider)
    } satisfies EnvelopeEncryptionProvider;
    const { owner, repository, team } =
      await createOwnerAndTeam(failingProvider);
    const name = `Atomic Workspace ${randomUUID()}`;
    const before = await pool.query<{
      audit: string;
      outbox: string;
      payloads: string;
    }>(
      `select
         (select count(*) from audit_events where action = 'team.workspace.created'
          and metadata ->> 'teamId' = $1 and metadata ->> 'teamWorkspaceId' is not null)::text as audit,
         (select count(*) from collaboration_outbox where resource_type = 'team_workspace'
          and team_id = $1::uuid)::text as outbox,
         (select count(*) from encrypted_field_payloads where source_table = 'team_workspaces')::text as payloads`,
      [team.id]
    );

    await expect(
      repository.createTeamWorkspace(
        { userId: owner.id },
        { teamId: team.id, name, description: "Must roll back" }
      )
    ).rejects.toThrow("injected encryption failure");

    const persisted = await pool.query<{ count: string }>(
      `select count(*)::text as count from team_workspaces where name = $1`,
      [name]
    );
    expect(persisted.rows[0]?.count).toBe("0");
    const related = await pool.query<{
      access: string;
      threads: string;
      audit: string;
      outbox: string;
      payloads: string;
    }>(
      `select
         (select count(*) from team_workspace_access_grants g
          join team_workspaces w on w.id = g.team_workspace_id where w.name = $1)::text as access,
         (select count(*) from collaboration_threads t
          join team_workspaces w on w.id = t.team_workspace_id where w.name = $1)::text as threads,
         (select count(*) from audit_events where action = 'team.workspace.created'
          and metadata ->> 'teamId' = $2 and metadata ->> 'teamWorkspaceId' is not null)::text as audit,
         (select count(*) from collaboration_outbox where resource_type = 'team_workspace'
          and team_id = $2::uuid)::text as outbox,
         (select count(*) from encrypted_field_payloads where source_table = 'team_workspaces')::text as payloads`,
      [name, team.id]
    );
    expect(related.rows[0]).toEqual({
      access: "0",
      threads: "0",
      audit: before.rows[0]!.audit,
      outbox: before.rows[0]!.outbox,
      payloads: before.rows[0]!.payloads
    });
  });

  it("allows no provider only when no description is supplied", async () => {
    const protectedFixture = await createOwnerAndTeam();
    const repository = createMemorySourceRepository(pool);
    const workspace = await repository.createTeamWorkspace(
      { userId: protectedFixture.owner.id },
      { teamId: protectedFixture.team.id, name: "No description" }
    );
    expect(workspace?.description).toBeNull();
    const nullWorkspace = await repository.createTeamWorkspace(
      { userId: protectedFixture.owner.id },
      {
        teamId: protectedFixture.team.id,
        name: "Explicitly null description",
        description: null
      }
    );
    expect(nullWorkspace?.description).toBeNull();
    await expect(
      repository.createTeamWorkspace(
        { userId: protectedFixture.owner.id },
        {
          teamId: protectedFixture.team.id,
          name: "Rejected description",
          description: "Cannot be stored without encryption"
        }
      )
    ).rejects.toThrow("Envelope encryption provider is required");
  });

  it("enforces normalization, nonempty content, and the UTF-8 byte limit at the repository boundary", async () => {
    const { owner, repository, team } = await createOwnerAndTeam();
    const exactly1024Bytes = "é".repeat(512);
    const accepted = await repository.createTeamWorkspace(
      { userId: owner.id },
      {
        teamId: team.id,
        name: "Repository boundary accepted",
        description: exactly1024Bytes
      }
    );
    expect(accepted?.description).toBe(exactly1024Bytes);

    await expect(
      repository.createTeamWorkspace(
        { userId: owner.id },
        {
          teamId: team.id,
          name: "Repository boundary too large",
          description: `${exactly1024Bytes}a`
        }
      )
    ).rejects.toThrow("between 1 and 1024 UTF-8 bytes");
    await expect(
      repository.createTeamWorkspace(
        { userId: owner.id },
        {
          teamId: team.id,
          name: "Repository boundary empty",
          description: "   "
        }
      )
    ).rejects.toThrow("between 1 and 1024 UTF-8 bytes");
    const rejectedRows = await pool.query<{ count: string }>(
      `select count(*)::text as count from team_workspaces
       where name in ('Repository boundary too large', 'Repository boundary empty')`
    );
    expect(rejectedRows.rows[0]?.count).toBe("0");
  });

  it("fails closed for a marked Workspace without the exact encrypted companion or provider", async () => {
    const { owner, repository, team } = await createOwnerAndTeam();
    const encrypted = await repository.createTeamWorkspace(
      { userId: owner.id },
      {
        teamId: team.id,
        name: "Encrypted Workspace",
        description: "Protected description"
      }
    );
    const plain = await repository.createTeamWorkspace(
      { userId: owner.id },
      { teamId: team.id, name: "Companion scope target" }
    );
    const otherEncrypted = await repository.createTeamWorkspace(
      { userId: owner.id },
      {
        teamId: team.id,
        name: "Different encrypted Workspace",
        description: "Must never decrypt for the target Workspace"
      }
    );

    const repositoryWithoutProvider = createMemorySourceRepository(pool);
    await expect(
      repositoryWithoutProvider.getTeamWorkspaceContext(
        { userId: owner.id },
        encrypted!.id
      )
    ).rejects.toThrow("Encrypted Team Workspace description is unavailable");

    await pool.query(
      `update encrypted_field_payloads
       set team_workspace_id = $2
       where source_table = 'team_workspaces' and source_id = $1`,
      [encrypted!.id, plain!.id]
    );
    await expect(
      repository.getTeamWorkspaceContext({ userId: owner.id }, encrypted!.id)
    ).rejects.toThrow("Encrypted Team Workspace description is unavailable");

    await pool.query(
      `update encrypted_field_payloads
       set team_workspace_id = $1
       where source_table = 'team_workspaces' and source_id = $1`,
      [encrypted!.id]
    );
    await pool.query(
      `update encrypted_field_payloads as target
       set envelope_version = source.envelope_version,
           provider_mode = source.provider_mode,
           key_id = source.key_id,
           key_version = source.key_version,
           scope = source.scope,
           provenance = source.provenance,
           algorithm = source.algorithm,
           ciphertext = source.ciphertext,
           nonce = source.nonce,
           tag = source.tag,
           wrapped_dek = source.wrapped_dek,
           ciphertext_location = source.ciphertext_location,
           aad = source.aad,
           envelope_created_at = source.envelope_created_at,
           envelope_reencrypted_at = source.envelope_reencrypted_at
       from encrypted_field_payloads as source
       where target.source_table = 'team_workspaces'
         and target.source_id = $1
         and target.source_column = 'description'
         and source.source_table = 'team_workspaces'
         and source.source_id = $2
         and source.source_column = 'description'`,
      [encrypted!.id, otherEncrypted!.id]
    );
    await expect(
      repository.getTeamWorkspaceContext({ userId: owner.id }, encrypted!.id)
    ).rejects.toThrow("Encrypted Team Workspace description is unavailable");

    await pool.query(
      `delete from encrypted_field_payloads
       where source_table = 'team_workspaces' and source_id = $1`,
      [encrypted!.id]
    );
    await expect(
      repository.getTeamWorkspaceContext({ userId: owner.id }, encrypted!.id)
    ).rejects.toThrow("Encrypted Team Workspace description is unavailable");
  });

  it("preserves the encrypted description through archive and restore", async () => {
    const { owner, repository, team } = await createOwnerAndTeam();
    const created = await repository.createTeamWorkspace(
      { userId: owner.id },
      {
        teamId: team.id,
        name: "Lifecycle Workspace",
        description: "Lifecycle-protected description"
      }
    );
    const archived = await repository.archiveTeamWorkspace(
      { userId: owner.id },
      { teamWorkspaceId: created!.id, expectedVersion: created!.version }
    );
    expect(archived).toMatchObject({
      lifecycle: "archived",
      description: "Lifecycle-protected description"
    });
    const restored = await repository.restoreTeamWorkspace(
      { userId: owner.id },
      { teamWorkspaceId: created!.id, expectedVersion: archived!.version }
    );
    expect(restored).toMatchObject({
      lifecycle: "active",
      description: "Lifecycle-protected description"
    });
  });

  it("refuses restoration after the Workspace encrypted payload is purged", async () => {
    const { owner, repository, team } = await createOwnerAndTeam();
    const created = await repository.createTeamWorkspace(
      { userId: owner.id },
      {
        teamId: team.id,
        name: "Purged Workspace",
        description: "Must not survive cryptographic purge"
      }
    );
    const archived = await repository.archiveTeamWorkspace(
      { userId: owner.id },
      { teamWorkspaceId: created!.id, expectedVersion: created!.version }
    );
    await pool.query(
      `delete from encrypted_field_payloads
        where source_table = 'team_workspaces'
          and source_id = $1
          and source_column = 'description'`,
      [created!.id]
    );
    const purged = await pool.query<{ version: number }>(
      `update team_workspaces
          set lifecycle = 'purged',
              archived_at = null,
              purge_completed_at = now(),
              version = version + 1,
              updated_at = now()
        where id = $1 and lifecycle = 'archived'
        returning version`,
      [created!.id]
    );
    expect(purged.rows).toHaveLength(1);

    await expect(
      repository.restoreTeamWorkspace(
        { userId: owner.id },
        {
          teamWorkspaceId: created!.id,
          expectedVersion: purged.rows[0]!.version
        }
      )
    ).resolves.toBeNull();

    const state = await pool.query<{
      lifecycle: string;
      purge_completed_at: Date | null;
      encrypted_payloads: string;
      restore_audits: string;
      active_general_threads: string;
    }>(
      `select
         w.lifecycle,
         w.purge_completed_at,
         (select count(*) from encrypted_field_payloads
           where source_table = 'team_workspaces' and source_id = w.id)::text
           as encrypted_payloads,
         (select count(*) from audit_events
           where action = 'team.workspace.restored' and target_id = w.id)::text
           as restore_audits,
         (select count(*) from collaboration_threads
           where team_workspace_id = w.id
             and system_key = 'workspace.general'
             and lifecycle = 'active')::text as active_general_threads
       from team_workspaces w where w.id = $1`,
      [created!.id]
    );
    expect(state.rows[0]).toMatchObject({
      lifecycle: "purged",
      encrypted_payloads: "0",
      restore_audits: "0",
      active_general_threads: "0"
    });
    expect(state.rows[0]!.purge_completed_at).toBeInstanceOf(Date);
    expect(archived!.lifecycle).toBe("archived");
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCollaborationRepository,
  createFlashcardDeckRepository,
  createMemorySourceRepository,
  createPersonalWorkspaceProjectRepository,
  createProjectApiRepository,
  createProjectSourceRepository,
  createWorkItemRepository,
  runDbMigrations,
  workspaceProjectCopyManifestHash
} from "@koed/db";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  readLocalEdgeClientCredentialAuthorization,
  storeDesktopLocalCredential,
  storeLocalEdgeClientCredential
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";
import { projectPersonalNoteToMemory } from "../collaboration/personal-note-memory.js";
import { createProjectSourceIngestionService } from "../projects/source-ingestion-service.js";
import { registerWorkspaceProjectCoordinationRoutes } from "./workspace-project-coordination-routes.js";

const testUrl = process.env.KOED_HQ712_COORDINATION_TEST_DATABASE_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const ids = {
  personalUser: randomUUID(),
  teamUser: randomUUID(),
  team: randomUUID(),
  workspace: randomUUID(),
  workspaceProject: randomUUID(),
  ownerMember: randomUUID(),
  copiedItem: randomUUID()
};
const deckIds = {
  personalDeck: randomUUID(),
  personalCard: randomUUID(),
  personalCardRemoved: randomUUID(),
  personalDeckRemoved: randomUUID(),
  personalCardOnRemovedDeck: randomUUID(),
  teamDeck: randomUUID(),
  teamCard: randomUUID(),
  teamCardRemoved: randomUUID(),
  teamDeckRemoved: randomUUID(),
  teamCardOnRemovedDeck: randomUUID()
};
const backendId = "team-vps";
const teamItem = () => ({
  id: ids.copiedItem,
  sourceOwnerTeamMemberId: ids.ownerMember,
  sourceWorkItemId: null,
  kind: "todo" as const,
  key: null,
  title: "Team-edited plan",
  goal: "Ship the plan",
  status: "todo" as const,
  dueOn: null,
  assigneeDisplayName: null,
  stepLabel: null,
  prUrl: null,
  prState: null,
  version: 2,
  doneAt: null,
  dispatchKey: null,
  createdAt: "2026-10-20T20:00:00.000Z",
  updatedAt: "2026-10-20T20:00:00.000Z"
});

describe.skipIf(!testUrl)(
  "Workspace Project local coordinator with stored Personal state",
  () => {
    let admin: pg.Pool;
    let pool: pg.Pool;
    let database = "";
    let home = "";
    let app: ReturnType<typeof Fastify>;
    let projectId: string;
    let projectVersion: number;
    let personalItemId: string;
    let personalSourceId: string;
    let localAuthorization: string;
    let teamAuthorization: string;
    let routeConfig: { deploymentProfile: string; koedHome: string };
    let manifestHash = "";
    let proofOwner = ids.teamUser;
    let targetCanStart = true;
    let cancelReplyStatus = 200;
    let cancelReceiptOwner = ids.teamUser;
    let proofProject = ids.workspaceProject;
    let statusPrincipal = ids.teamUser;
    let lifecycleProject = ids.workspaceProject;
    let lifecycleActive = true;
    let lifecycleCanWrite = true;
    let sourceRepository: ReturnType<typeof createProjectSourceRepository>;
    const encryptionProvider = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64url")
    );
    let sourceIngestionRequests = 0;
    const teamSourceId = randomUUID();
    let uploadedPersonalSourceId: string = randomUUID();
    let uploaderProofReads = 0;
    let publishedNoteId: string | null = null;
    let publishedNoteRevisionId: string | null = null;
    let changeSourceVersionOnSecondRead = false;
    let revokeUploaderProofOnSecondRead = false;
    let tombstoneReady = false;
    let activeOwnerCount = 2;
    let membershipRole: "owner" | "member" = "owner";
    const teamCalls: string[] = [];
    const leaveItems = Array.from({ length: 51 }, (_, index) => ({
      ...teamItem(),
      id: index === 0 ? ids.copiedItem : randomUUID(),
      title: `Team-edited plan ${index}`
    }));
    let staleLeavePage = false;
    let unlinkedOwnedProject = false;
    let noOwnedProjects = false;
    let teamDeckUnavailable = false;
    let teamDeckRevoked = false;
    let teamDeckMismatched = false;
    const leavePageOffsets: number[] = [];

    const send = (
      url: string,
      body: unknown,
      options: {
        authorization?: string;
        teamCredential?: string;
        remoteAddress?: string;
      } = {}
    ) =>
      app.inject({
        method: "POST",
        url,
        remoteAddress: options.remoteAddress ?? "127.0.0.1",
        headers: {
          authorization: options.authorization ?? localAuthorization,
          "x-koed-team-client-credential":
            options.teamCredential ?? teamAuthorization
        },
        payload: body
      });

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: testUrl });
      database = `hq712_coord_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`create database ${quote(database)}`);
      const databaseUrl = new URL(testUrl!);
      databaseUrl.pathname = `/${database}`;
      pool = new pg.Pool({ connectionString: databaseUrl.toString() });
      await runDbMigrations(pool);
      await pool.query("insert into users(id,email) values($1,$2),($3,$4)", [
        ids.personalUser,
        `${ids.personalUser}@example.test`,
        ids.teamUser,
        `${ids.teamUser}@example.test`
      ]);
      await pool.query(
        `insert into deployment_identities(protocol_deployment_id,locality,profile)
      values($1,'local','developer')`,
        [randomUUID()]
      );
      const project = await createProjectApiRepository(pool).create(
        ids.personalUser,
        {
          name: "Local plan",
          idempotencyKey: "hq712-coordination-project"
        }
      );
      projectId = project.id;
      projectVersion = project.version;
      const personalItem = await createWorkItemRepository(pool).create(
        ids.personalUser,
        projectId,
        {
          kind: "todo",
          title: "Original plan",
          goal: "Ship the plan",
          origin: "me",
          idempotencyKey: "hq712-original-item"
        }
      );
      personalItemId = personalItem.id;
      const personalSource = await createProjectSourceRepository(pool).create(
        ids.personalUser,
        projectId,
        { kind: "skill", name: "Plan skill" }
      );
      personalSourceId = personalSource.id;
      await pool.query(
        `insert into project_decks(id,owner_user_id,project_id,title,scope,made_from,idempotency_key,creation_payload_hash)
         values($1,$2,$3,'Original Deck','Unit 1','Notes',$4,$5)`,
        [
          deckIds.personalDeck,
          ids.personalUser,
          projectId,
          randomUUID(),
          "a".repeat(64)
        ]
      );
      await pool.query(
        `insert into deck_cards(id,owner_user_id,deck_id,question,answer,source_ref)
         values($1,$2,$3,'Original question','Original answer','Notes p. 1')`,
        [deckIds.personalCard, ids.personalUser, deckIds.personalDeck]
      );
      await pool.query(
        `insert into deck_cards(id,owner_user_id,deck_id,question,answer)
         values($1,$2,$3,'Removed card','Removed answer')`,
        [deckIds.personalCardRemoved, ids.personalUser, deckIds.personalDeck]
      );
      await pool.query(
        `insert into project_decks(id,owner_user_id,project_id,title,scope,made_from,idempotency_key,creation_payload_hash)
         values($1,$2,$3,'Removed Deck','Unit 2','Notes',$4,$5)`,
        [
          deckIds.personalDeckRemoved,
          ids.personalUser,
          projectId,
          randomUUID(),
          "b".repeat(64)
        ]
      );
      await pool.query(
        `insert into deck_cards(id,owner_user_id,deck_id,question,answer)
         values($1,$2,$3,'Removed Deck question','Removed Deck answer')`,
        [
          deckIds.personalCardOnRemovedDeck,
          ids.personalUser,
          deckIds.personalDeckRemoved
        ]
      );
      await createFlashcardDeckRepository(pool).putProgress(
        ids.personalUser,
        projectId,
        deckIds.personalDeck,
        deckIds.personalCard,
        { box: 3, nextAt: null, misses: 1 }
      );
      const repository = createPersonalWorkspaceProjectRepository(pool);
      manifestHash = workspaceProjectCopyManifestHash(
        await repository.shareSnapshot(ids.personalUser, projectId)
      );
      home = mkdtempSync(resolve(tmpdir(), "koed-hq712-coordination-"));
      localAuthorization = storeDesktopLocalCredential(home, {
        ownerUserId: ids.personalUser,
        operationFamilies: [
          "personal_collaboration_read",
          "personal_collaboration_write"
        ]
      }).authorization;
      storeLocalEdgeClientCredential(home, {
        backendId,
        secret: "hq712-team-client-secret",
        operationFamilies: ["team_workspace_read"]
      });
      teamAuthorization = readLocalEdgeClientCredentialAuthorization(
        home,
        backendId
      )!.authorization;
      const registryPath = resolve(home, "team-backends.json");
      writeFileSync(
        registryPath,
        JSON.stringify({
          schemaVersion: 2,
          activeBackendId: backendId,
          backends: [
            {
              id: backendId,
              baseUrl: "https://team.example.test/",
              routePolicy: { teamWorkspaceRead: "enabled" }
            }
          ]
        })
      );
      const teamFetch: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const path = url.pathname;
        teamCalls.push(path);
        expect(init?.headers).toMatchObject({
          authorization: "Koed-Device upstream-key:upstream-secret"
        });
        let payload: unknown;
        if (path === "/v1/local-edge/device-credentials/status")
          payload = {
            ok: true,
            auth: "device_credential",
            user: { id: statusPrincipal }
          };
        else if (
          path ===
          `/v1/teams/${ids.team}/workspaces/${ids.workspace}/share-target`
        )
          payload = {
            teamId: ids.team,
            workspaceId: ids.workspace,
            ownerUserId: proofOwner,
            canStart: targetCanStart
          };
        else if (
          path ===
          `/v1/teams/${ids.team}/workspaces/${ids.workspace}/share-attempt-cancellations`
        ) {
          if (cancelReplyStatus !== 200)
            return new Response(JSON.stringify({ error: "Team unavailable" }), {
              status: cancelReplyStatus,
              headers: { "content-type": "application/json" }
            });
          const cancelBody = JSON.parse(String(init?.body)) as {
            shareAttemptKey: string;
            expectedOwnerUserId: string;
          };
          expect(cancelBody.expectedOwnerUserId).toBe(ids.teamUser);
          const { shareAttemptKey } = cancelBody;
          payload = {
            canceled: true,
            receiptId: ids.workspaceProject,
            teamId: ids.team,
            workspaceId: ids.workspace,
            ownerUserId: cancelReceiptOwner,
            shareAttemptKey
          };
        } else if (
          path === `/v1/workspace-projects/${ids.workspaceProject}/link-proof`
        )
          payload = {
            projectId: proofProject,
            workspaceId: ids.workspace,
            teamId: ids.team,
            ownerTeamMemberId: ids.ownerMember,
            ownerUserId: proofOwner,
            projectVersion: 1,
            copyManifestHash: manifestHash
          };
        else if (
          path ===
          `/v1/workspace-projects/${ids.workspaceProject}/deck-copy-map`
        )
          payload = {
            projectId: ids.workspaceProject,
            copyManifestHash: manifestHash,
            cards: [
              {
                sourceDeckId: deckIds.personalDeck,
                deckId: deckIds.teamDeck,
                sourceCardId: deckIds.personalCard,
                cardId: deckIds.teamCard
              },
              {
                sourceDeckId: deckIds.personalDeck,
                deckId: deckIds.teamDeck,
                sourceCardId: deckIds.personalCardRemoved,
                cardId: deckIds.teamCardRemoved
              },
              {
                sourceDeckId: deckIds.personalDeckRemoved,
                deckId: deckIds.teamDeckRemoved,
                sourceCardId: deckIds.personalCardOnRemovedDeck,
                cardId: deckIds.teamCardOnRemovedDeck
              }
            ]
          };
        else if (
          path ===
          `/v1/workspace-projects/${ids.workspaceProject}/copy-back-decks`
        )
          payload = {
            projectId: ids.workspaceProject,
            projectVersion: 1,
            decks: [
              {
                id: deckIds.teamDeck,
                sourceOwnerTeamMemberId: ids.ownerMember,
                sourceDeckId: deckIds.personalDeck,
                title: "Team-edited Deck",
                scope: "Unit 1",
                madeFrom: "Notes",
                createdByAgentId: null,
                cards: [
                  {
                    id: deckIds.teamCard,
                    sourceCardId: deckIds.personalCard,
                    question: "Team-edited question",
                    answer: "Team-edited answer",
                    sourceRef: "Notes p. 2",
                    topicLabel: null
                  }
                ]
              }
            ]
          };
        else if (
          path ===
          `/v1/workspace-projects/${ids.workspaceProject}/decks/${deckIds.teamDeck}`
        ) {
          if (teamDeckUnavailable)
            return new Response(JSON.stringify({ error: "Team unavailable" }), {
              status: 503,
              headers: { "content-type": "application/json" }
            });
          if (teamDeckRevoked)
            return new Response(
              JSON.stringify({ error: "Team access revoked" }),
              {
                status: 403,
                headers: { "content-type": "application/json" }
              }
            );
          payload = {
            id: deckIds.teamDeck,
            projectId: teamDeckMismatched ? randomUUID() : ids.workspaceProject,
            title: "Team-edited Deck",
            scope: "Unit 1",
            madeFrom: "Notes",
            createdByAgentId: null,
            uses: 0,
            version: 1,
            createdAt: "2026-10-20T20:00:00.000Z",
            updatedAt: "2026-10-20T20:00:00.000Z",
            cards: [
              {
                id: deckIds.teamCard,
                deckId: deckIds.teamDeck,
                question: "Team-edited question",
                answer: "Team-edited answer",
                sourceRef: "Notes p. 2",
                topicLabel: null,
                version: 1,
                createdAt: "2026-10-20T20:00:00.000Z",
                updatedAt: "2026-10-20T20:00:00.000Z"
              }
            ]
          };
        } else if (
          path === `/v1/workspace-projects/${ids.workspaceProject}/lifecycle`
        )
          payload = {
            id: lifecycleProject,
            active: lifecycleActive,
            canWrite: lifecycleCanWrite,
            version: 2,
            memberVersion: 1
          };
        else if (
          path === `/v1/teams/${ids.team}/workspace-project-leave-review`
        )
          payload = {
            team: { id: ids.team, version: 3 },
            membership: {
              userId: ids.teamUser,
              role: membershipRole,
              version: 2
            },
            activeOwnerCount,
            ownedWorkspaceProjects: noOwnedProjects
              ? []
              : unlinkedOwnedProject
                ? [
                    { id: randomUUID(), version: 1 },
                    { id: ids.workspaceProject, version: 1 }
                  ]
                : [{ id: ids.workspaceProject, version: 1 }]
          };
        else if (
          path === `/v1/workspace-projects/${ids.workspaceProject}/work-items`
        ) {
          const offset = Number(url.searchParams.get("offset"));
          expect(url.searchParams.get("expectedProjectVersion")).toBe("1");
          leavePageOffsets.push(offset);
          payload = {
            items: leaveItems.slice(offset, offset + 50),
            nextOffset: offset + 50 < leaveItems.length ? offset + 50 : null,
            projectVersion: staleLeavePage && offset > 0 ? 2 : 1
          };
        } else if (
          path ===
          `/v1/workspace-projects/${ids.workspaceProject}/tombstone-proof`
        )
          payload = {
            projectId: ids.workspaceProject,
            teamId: ids.team,
            ownerUserId: ids.teamUser,
            version: tombstoneReady ? 2 : 1,
            allMemberLinksDisabled: tombstoneReady,
            grantsFrozen: tombstoneReady,
            threadArchived: tombstoneReady
          };
        else if (
          path ===
          `/v1/workspace-projects/${ids.workspaceProject}/sources/${teamSourceId}/uploader-proof`
        ) {
          uploaderProofReads++;
          if (revokeUploaderProofOnSecondRead && uploaderProofReads % 2 === 0)
            return new Response(JSON.stringify({ error: "access revoked" }), {
              status: 403,
              headers: { "content-type": "application/json" }
            });
          payload = {
            workspaceProjectId: ids.workspaceProject,
            sourceId: teamSourceId,
            sourceProjectSourceId: uploadedPersonalSourceId,
            uploaderTeamMemberId: ids.ownerMember,
            sourceVersion:
              changeSourceVersionOnSecondRead && uploaderProofReads % 2 === 0
                ? 2
                : 1,
            personalNoteId: publishedNoteId,
            personalNoteRevisionId: publishedNoteRevisionId
          };
        } else throw new Error(`Unexpected Team request: ${path}`);
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      };
      routeConfig = { deploymentProfile: "developer", koedHome: home };
      const context = {
        config: routeConfig,
        auth: {
          authenticateSessionOrDeviceCredential: async () => {
            throw Object.assign(
              new Error("Browser/API credential cannot coordinate Projects"),
              { statusCode: 403 }
            );
          }
        },
        rateLimit: {
          memoryWrite: async () => undefined,
          memoryRead: async () => undefined
        },
        localEdge: {
          upstreamBackendsPath: registryPath,
          fetch: teamFetch,
          resolveUpstreamAuthorization: () =>
            "Koed-Device upstream-key:upstream-secret"
        }
      } as unknown as ApiRouteContext;
      app = Fastify();
      sourceRepository = createProjectSourceRepository(pool, {
        envelopeEncryptionProvider: encryptionProvider
      });
      registerWorkspaceProjectCoordinationRoutes(
        app,
        context,
        repository,
        sourceRepository,
        () => {
          sourceIngestionRequests++;
        },
        createFlashcardDeckRepository(pool)
      );
      await app.ready();
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await pool?.end();
      if (admin && database)
        await admin.query(`drop database ${quote(database)}`);
      await admin?.end();
      if (home) rmSync(home, { recursive: true, force: true });
    });

    it("requires two independently enrolled credentials on local loopback", async () => {
      expect(ids.personalUser).not.toBe(ids.teamUser);
      const path = `/v1/local-edge/projects/${projectId}/workspace-project-confirm`;
      const body = {
        teamBackendId: backendId,
        workspaceProjectId: ids.workspaceProject,
        expectedPersonalProjectVersion: projectVersion
      };
      const missingTeam = await send(path, body, { teamCredential: "" });
      expect(missingTeam.statusCode).toBe(403);
      expect(
        (await send(path, { ...body, teamBackendId: "other-team-backend" }))
          .statusCode
      ).toBe(403);
      const bearer = await send(path, body, {
        authorization: "Bearer browser-token"
      });
      expect(bearer.statusCode).toBe(403);
      const remote = await send(path, body, { remoteAddress: "198.51.100.7" });
      expect(remote.statusCode).toBe(403);
      routeConfig.deploymentProfile = "private_vps";
      try {
        expect((await send(path, body)).statusCode).toBe(403);
      } finally {
        routeConfig.deploymentProfile = "developer";
      }
      expect(teamCalls).toHaveLength(0);
    });

    it("permits Native Team leave preflight with no owned Projects before any Personal link exists", async () => {
      noOwnedProjects = true;
      const review = await send(
        "/v1/local-edge/workspace-project-team-leave-stage",
        {
          teamBackendId: backendId,
          teamId: ids.team
        }
      );
      expect(review.statusCode, review.body).toBe(200);
      expect(review.json()).toMatchObject({
        expectedOwnedWorkspaceProjects: [],
        stages: []
      });
      expect(
        (
          await pool.query(
            "select count(*)::int as n from personal_workspace_project_copyback_stages"
          )
        ).rows[0]?.n
      ).toBe(0);
      noOwnedProjects = false;
    });

    it("keeps a pending Personal fence on uncertain Team cancellation and clears it only after an exact receipt", async () => {
      const cancelProject = randomUUID();
      await pool.query(
        "insert into projects(id,owner_user_id,name,key) values($1,$2,'Cancel plan','CANCEL')",
        [cancelProject, ids.personalUser]
      );
      storeLocalEdgeClientCredential(home, {
        backendId,
        secret: "hq701-team-write-secret",
        operationFamilies: ["team_workspace_read", "team_workspace_write"]
      });
      teamAuthorization = readLocalEdgeClientCredentialAuthorization(
        home,
        backendId
      )!.authorization;
      const preparePath = `/v1/local-edge/projects/${cancelProject}/workspace-project-prepare`;
      const cancelPath = `/v1/local-edge/projects/${cancelProject}/workspace-project-share-cancel`;
      const input = {
        teamBackendId: backendId,
        shareAttemptKey: "hq701-cancel-attempt",
        targetTeamId: ids.team,
        targetWorkspaceId: ids.workspace
      };
      expect((await send(preparePath, input)).statusCode).toBe(200);
      expect(
        (await send(cancelPath, { targetTeamId: randomUUID() })).statusCode
      ).toBeGreaterThanOrEqual(400);
      cancelReplyStatus = 503;
      expect((await send(cancelPath, {})).statusCode).toBe(424);
      expect(
        await createPersonalWorkspaceProjectRepository(pool).pendingShare(
          ids.personalUser,
          cancelProject
        )
      ).toMatchObject(input);
      cancelReplyStatus = 409;
      const alreadyCreated = await send(cancelPath, {});
      expect(alreadyCreated.statusCode).toBe(409);
      expect(alreadyCreated.body).toContain("resume sharing");
      expect(
        await createPersonalWorkspaceProjectRepository(pool).pendingShare(
          ids.personalUser,
          cancelProject
        )
      ).toMatchObject(input);
      cancelReplyStatus = 200;
      cancelReceiptOwner = randomUUID();
      expect((await send(cancelPath, {})).statusCode).toBe(409);
      expect(
        await createPersonalWorkspaceProjectRepository(pool).pendingShare(
          ids.personalUser,
          cancelProject
        )
      ).toMatchObject(input);
      cancelReceiptOwner = ids.teamUser;
      expect((await send(cancelPath, {})).json()).toMatchObject({
        canceled: true,
        shareAttemptKey: input.shareAttemptKey
      });
      expect(
        await createPersonalWorkspaceProjectRepository(pool).pendingShare(
          ids.personalUser,
          cancelProject
        )
      ).toBeNull();
      expect((await send(cancelPath, {})).statusCode).toBe(200);
      expect((await send(preparePath, input)).statusCode).toBe(409);
      expect(
        (
          await send(preparePath, {
            ...input,
            shareAttemptKey: "hq701-new-attempt"
          })
        ).statusCode
      ).toBe(200);
      storeLocalEdgeClientCredential(home, {
        backendId,
        secret: "hq712-team-client-secret",
        operationFamilies: ["team_workspace_read"]
      });
      teamAuthorization = readLocalEdgeClientCredentialAuthorization(
        home,
        backendId
      )!.authorization;
    });

    it("checks exact Personal manifest and Team owner, then binds backend-qualified principals", async () => {
      const path = `/v1/local-edge/projects/${projectId}/workspace-project-confirm`;
      const preparePath = `/v1/local-edge/projects/${projectId}/workspace-project-prepare`;
      const body = {
        teamBackendId: backendId,
        workspaceProjectId: ids.workspaceProject,
        expectedPersonalProjectVersion: projectVersion
      };
      targetCanStart = false;
      expect(
        (
          await send(preparePath, {
            teamBackendId: backendId,
            shareAttemptKey: "hq712-first-share-attempt",
            targetTeamId: ids.team,
            targetWorkspaceId: ids.workspace
          })
        ).statusCode
      ).toBe(409);
      expect(
        (
          await pool.query(
            "select 1 from personal_workspace_project_share_attempts where personal_project_id=$1",
            [projectId]
          )
        ).rowCount
      ).toBe(0);
      targetCanStart = true;
      const prepared = await send(preparePath, {
        teamBackendId: backendId,
        shareAttemptKey: "hq712-first-share-attempt",
        targetTeamId: ids.team,
        targetWorkspaceId: ids.workspace
      });
      expect(prepared.statusCode, prepared.body).toBe(200);
      expect(prepared.json()).toMatchObject({ manifestHash });
      const recovery = () =>
        app.inject({
          method: "GET",
          url: `/v1/local-edge/projects/${projectId}/workspace-project-share-attempt`,
          remoteAddress: "127.0.0.1",
          headers: {
            authorization: localAuthorization,
            "x-koed-team-client-credential": teamAuthorization
          }
        });
      expect((await recovery()).json()).toMatchObject({
        attempt: {
          teamBackendId: backendId,
          shareAttemptKey: "hq712-first-share-attempt",
          targetTeamId: ids.team,
          targetWorkspaceId: ids.workspace,
          state: "pending"
        }
      });
      proofOwner = randomUUID();
      expect((await recovery()).statusCode).toBe(409);
      proofOwner = ids.teamUser;
      expect(
        (
          await send(preparePath, {
            teamBackendId: backendId,
            shareAttemptKey: "a-different-share-attempt",
            targetTeamId: ids.team,
            targetWorkspaceId: ids.workspace
          })
        ).statusCode
      ).toBe(409);
      await expect(
        createWorkItemRepository(pool).patch(ids.personalUser, personalItemId, {
          version: 1,
          title: "Edit during Team copy"
        })
      ).rejects.toThrow("Personal Project first share is pending");
      await expect(
        pool.query(
          "update project_sources set name='Changed during copy' where id=$1",
          [personalSourceId]
        )
      ).rejects.toThrow("Personal Project first share is pending");
      const resumed = await send(preparePath, {
        teamBackendId: backendId,
        shareAttemptKey: "hq712-first-share-attempt",
        targetTeamId: ids.team,
        targetWorkspaceId: ids.workspace
      });
      expect(resumed.statusCode, resumed.body).toBe(200);
      expect(resumed.json()).toEqual(prepared.json());
      proofOwner = randomUUID();
      expect((await send(path, body)).statusCode).toBe(409);
      proofOwner = ids.teamUser;
      proofProject = randomUUID();
      expect((await send(path, body)).statusCode).toBe(409);
      proofProject = ids.workspaceProject;
      const validHash = manifestHash;
      manifestHash = "0".repeat(64);
      expect((await send(path, body)).statusCode).toBe(409);
      manifestHash = validHash;
      const confirmed = await send(path, body);
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json()).toMatchObject({ projectId, moved: true });
      const link = await pool.query(
        `select team_backend_id,team_workspace_id,workspace_project_id
      from projects where id=$1`,
        [projectId]
      );
      expect(link.rows[0]).toMatchObject({
        team_backend_id: backendId,
        team_workspace_id: ids.workspace,
        workspace_project_id: ids.workspaceProject
      });
      expect(
        (
          await pool.query(
            "select deck_id,card_id,box,misses,team_backend_id,workspace_project_id from deck_card_progress where owner_user_id=$1 and personal_project_id=$2",
            [ids.personalUser, projectId]
          )
        ).rows
      ).toMatchObject([
        {
          deck_id: deckIds.teamDeck,
          card_id: deckIds.teamCard,
          box: 3,
          misses: 1,
          team_backend_id: backendId,
          workspace_project_id: ids.workspaceProject
        }
      ]);
      const principal = await pool.query(
        `select local_user_id,team_backend_id,team_principal_user_id
      from personal_workspace_project_principal_bindings where local_user_id=$1`,
        [ids.personalUser]
      );
      expect(principal.rows[0]).toMatchObject({
        local_user_id: ids.personalUser,
        team_backend_id: backendId,
        team_principal_user_id: ids.teamUser
      });
      expect((await send(path, body)).statusCode).toBe(200);
      const reconcilePath = `/v1/local-edge/projects/${projectId}/workspace-project-reconcile`;
      statusPrincipal = randomUUID();
      expect((await send(reconcilePath, {})).statusCode).toBe(409);
      statusPrincipal = ids.teamUser;
      lifecycleProject = randomUUID();
      expect((await send(reconcilePath, {})).statusCode).toBe(409);
      lifecycleProject = ids.workspaceProject;
      const stillLinked = await pool.query(
        "select workspace_project_id from projects where id=$1",
        [projectId]
      );
      expect(stillLinked.rows[0]?.workspace_project_id).toBe(
        ids.workspaceProject
      );
    });

    it("keeps shared Deck progress Personal behind live Team read proof", async () => {
      const base = `/v1/local-edge/projects/${projectId}/decks/${deckIds.teamDeck}`;
      const request = (method: "GET" | "PUT", url: string, payload?: unknown) =>
        app.inject({
          method,
          url,
          remoteAddress: "127.0.0.1",
          headers: {
            authorization: localAuthorization,
            "x-koed-team-client-credential": teamAuthorization
          },
          ...(payload === undefined ? {} : { payload })
        });
      const read = () => request("GET", `${base}/progress`);
      const write = () =>
        request("PUT", `${base}/cards/${deckIds.teamCard}/progress`, {
          box: 4,
          nextAt: null,
          misses: 2
        });
      expect((await read()).json()).toMatchObject({
        progress: [{ cardId: deckIds.teamCard, box: 3, misses: 1 }]
      });
      expect((await write()).statusCode).toBe(200);
      expect((await read()).json()).toMatchObject({
        progress: [{ cardId: deckIds.teamCard, box: 4, misses: 2 }]
      });
      teamDeckUnavailable = true;
      expect((await read()).statusCode).toBe(424);
      expect((await write()).statusCode).toBe(424);
      teamDeckUnavailable = false;
      teamDeckRevoked = true;
      expect((await read()).statusCode).toBe(424);
      expect((await write()).statusCode).toBe(424);
      teamDeckRevoked = false;
      teamDeckMismatched = true;
      expect((await read()).statusCode).toBe(409);
      expect((await write()).statusCode).toBe(409);
      teamDeckMismatched = false;
      statusPrincipal = randomUUID();
      expect((await read()).statusCode).toBe(409);
      expect((await write()).statusCode).toBe(409);
      statusPrincipal = ids.teamUser;
      const noTeamCredential = await app.inject({
        method: "GET",
        url: `${base}/progress`,
        remoteAddress: "127.0.0.1",
        headers: { authorization: localAuthorization }
      });
      expect(noTeamCredential.statusCode).toBe(403);
    });

    it("uploads through exact dual authority, keeps real Note bytes Personal, and rechecks uploader access after decrypt", async () => {
      const path = `/v1/local-edge/projects/${projectId}/workspace-project-sources/upload`;
      const text =
        "Uploader-private Source content. Shared metadata must contain no text.";
      const body = {
        teamBackendId: backendId,
        workspaceProjectId: ids.workspaceProject,
        upload: {
          name: "Shared-plan.txt",
          mediaType: "text/plain",
          bytesBase64: Buffer.from(text).toString("base64"),
          idempotencyKey: "hq712-source-uploader"
        }
      };
      expect((await send(path, body)).statusCode).toBe(403);
      expect(sourceIngestionRequests).toBe(0);
      storeLocalEdgeClientCredential(home, {
        backendId,
        secret: "hq712-team-write-secret",
        operationFamilies: ["team_workspace_read", "team_workspace_write"]
      });
      teamAuthorization = readLocalEdgeClientCredentialAuthorization(
        home,
        backendId
      )!.authorization;
      lifecycleCanWrite = false;
      expect((await send(path, body)).statusCode).toBe(403);
      lifecycleCanWrite = true;
      expect(
        (await send(path, { ...body, workspaceProjectId: randomUUID() }))
          .statusCode
      ).toBe(404);
      const uploaded = await send(path, body);
      expect(uploaded.statusCode, uploaded.body).toBe(202);
      uploadedPersonalSourceId = (uploaded.json() as { id: string }).id;
      expect(sourceIngestionRequests).toBe(1);
      expect(uploaded.body).not.toContain(text);
      await expect(
        sourceRepository.uploadDocument(ids.personalUser, projectId, {
          ...body.upload,
          idempotencyKey: "ordinary-linked-denied"
        })
      ).rejects.toThrow();
      const errors: unknown[] = [];
      const ingest = async () => {
        const ingestion = createProjectSourceIngestionService({
          repository: sourceRepository,
          intervalMs: 3600000,
          projectNote: async ({ ownerUserId, note }) => {
            await projectPersonalNoteToMemory(
              {
                repository: {
                  ...createMemorySourceRepository(pool, {
                    envelopeEncryptionProvider: encryptionProvider
                  }),
                  ...createCollaborationRepository(pool, {
                    envelopeEncryptionProvider: encryptionProvider
                  })
                },
                enqueueEmbedding: async () => ({
                  queued: false,
                  inline: false,
                  reason: "test"
                })
              },
              { ownerUserId, note }
            );
          },
          onError: (error) => errors.push(error)
        });
        await ingestion.runNow();
        await ingestion.close();
        expect(errors).toEqual([]);
      };
      await ingest();
      const revision = await pool.query<{ current_revision_id: string }>(
        "select current_revision_id from project_sources where id=$1",
        [uploadedPersonalSourceId]
      );
      const note = await pool.query(
        "select id,note_id from personal_note_revisions where id=$1 and owner_user_id=$2",
        [revision.rows[0]!.current_revision_id, ids.personalUser]
      );
      expect(note.rows).toHaveLength(1);
      const metadata = (
        await createPersonalWorkspaceProjectRepository(pool).shareSnapshot(
          ids.personalUser,
          projectId
        )
      ).sources.find((source) => source.id === uploadedPersonalSourceId);
      expect(metadata).toMatchObject({
        personalNoteId: note.rows[0]?.note_id,
        personalNoteRevisionId: revision.rows[0]!.current_revision_id
      });
      publishedNoteId = metadata!.personalNoteId;
      publishedNoteRevisionId = metadata!.personalNoteRevisionId;
      expect(metadata?.personalNoteId).not.toBe(
        metadata?.personalNoteRevisionId
      );
      expect(JSON.stringify(metadata)).not.toContain(text);
      const contentPath = `/v1/local-edge/projects/${projectId}/workspace-project-sources/${teamSourceId}/content?teamBackendId=${backendId}&workspaceProjectId=${ids.workspaceProject}`;
      const read = () =>
        app.inject({
          method: "GET",
          url: contentPath,
          headers: {
            authorization: localAuthorization,
            "x-koed-team-client-credential": teamAuthorization
          },
          remoteAddress: "127.0.0.1"
        });
      uploaderProofReads = 0;
      const content = await read();
      expect(content.statusCode, content.body).toBe(200);
      expect(content.json()).toMatchObject({
        text,
        noteRevisionId: revision.rows[0]!.current_revision_id,
        sourceId: uploadedPersonalSourceId
      });
      expect(uploaderProofReads).toBe(2);
      uploaderProofReads = 0;
      changeSourceVersionOnSecondRead = true;
      const changedMetadata = await read();
      expect(changedMetadata.statusCode, changedMetadata.body).toBe(409);
      expect(changedMetadata.body).not.toContain(text);
      changeSourceVersionOnSecondRead = false;
      uploaderProofReads = 0;
      revokeUploaderProofOnSecondRead = true;
      const denied = await read();
      expect(denied.statusCode).toBeGreaterThanOrEqual(400);
      expect(denied.body).not.toContain(text);
      revokeUploaderProofOnSecondRead = false;
      await sourceRepository.forgetDocumentNoteRevision(
        ids.personalUser,
        revision.rows[0]!.current_revision_id
      );
      const replacedText = "Replacement Note after forgetting the original.";
      const replacement = await send(path, {
        ...body,
        upload: {
          ...body.upload,
          bytesBase64: Buffer.from(replacedText).toString("base64"),
          idempotencyKey: "hq712-source-replacement"
        }
      });
      expect(replacement.statusCode, replacement.body).toBe(202);
      expect(replacement.json()).toMatchObject({
        id: uploadedPersonalSourceId
      });
      await ingest();
      const replacedMetadata = (
        await createPersonalWorkspaceProjectRepository(pool).shareSnapshot(
          ids.personalUser,
          projectId
        )
      ).sources.find((source) => source.id === uploadedPersonalSourceId);
      expect(replacedMetadata?.personalNoteId).toBeTruthy();
      expect(replacedMetadata?.personalNoteId).not.toBe(
        metadata?.personalNoteId
      );
      expect(replacedMetadata?.personalNoteRevisionId).not.toBe(
        metadata?.personalNoteRevisionId
      );
      const staleMetadata = await read();
      expect(staleMetadata.statusCode, staleMetadata.body).toBe(409);
      expect(staleMetadata.body).not.toContain(replacedText);
      publishedNoteId = replacedMetadata!.personalNoteId;
      publishedNoteRevisionId = replacedMetadata!.personalNoteRevisionId;
      expect((await read()).json()).toMatchObject({
        text: replacedText,
        sourceId: uploadedPersonalSourceId,
        noteRevisionId: replacedMetadata?.personalNoteRevisionId
      });
      expect(
        teamCalls.filter((call) => /share-grant|pending-share/.test(call))
      ).toEqual([]);
      const maximum = Buffer.alloc(25 * 1024 * 1024, 65);
      const large = await send(path, {
        ...body,
        upload: {
          ...body.upload,
          name: "Maximum.txt",
          bytesBase64: maximum.toString("base64"),
          idempotencyKey: "hq712-maximum-shared-source"
        }
      });
      expect(large.statusCode, large.body).toBe(202);
      const claimed = await sourceRepository.claimDocumentAttempt();
      expect(claimed?.bytes.equals(maximum)).toBe(true);
      expect(claimed?.ownerUserId).toBe(ids.personalUser);
    }, 120000);

    it("stages D9 invisibly, rejects unverified leave, then applies exactly once after Team tombstone", async () => {
      const stagePath = "/v1/local-edge/workspace-project-team-leave-stage";
      const finishPath = "/v1/local-edge/workspace-project-team-leave-finish";
      activeOwnerCount = 1;
      const lastOwner = await send(stagePath, {
        teamBackendId: backendId,
        teamId: ids.team
      });
      expect(lastOwner.statusCode, lastOwner.body).toBe(409);
      membershipRole = "member";
      unlinkedOwnedProject = true;
      const unlinked = await send(stagePath, {
        teamBackendId: backendId,
        teamId: ids.team
      });
      expect(unlinked.statusCode, unlinked.body).toBe(409);
      expect(unlinked.body).toContain("verified Personal link");
      expect(leavePageOffsets).toHaveLength(0);
      unlinkedOwnedProject = false;
      staleLeavePage = true;
      const stale = await send(stagePath, {
        teamBackendId: backendId,
        teamId: ids.team
      });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(
        (
          await pool.query(
            "select count(*)::int as n from personal_workspace_project_copyback_stages"
          )
        ).rows[0]?.n
      ).toBe(0);
      expect(leavePageOffsets).toEqual([0, 50]);
      staleLeavePage = false;
      expect(
        (
          await send(stagePath, {
            teamBackendId: backendId,
            teamId: ids.team
          })
        ).statusCode
      ).toBe(200);
      membershipRole = "owner";
      activeOwnerCount = 2;
      const staged = await send(stagePath, {
        teamBackendId: backendId,
        teamId: ids.team
      });
      expect(staged.statusCode, staged.body).toBe(200);
      const stageId = (staged.json() as { stages: Array<{ stageId: string }> })
        .stages[0]?.stageId;
      expect(stageId).toBeDefined();
      const repeatedStage = await send(stagePath, {
        teamBackendId: backendId,
        teamId: ids.team
      });
      expect(repeatedStage.statusCode, repeatedStage.body).toBe(200);
      expect(repeatedStage.json()).toMatchObject({ stages: [{ stageId }] });
      const before = await pool.query(
        "select workspace_project_id from projects where id=$1",
        [projectId]
      );
      expect(before.rows[0]?.workspace_project_id).toBe(ids.workspaceProject);
      const initialItems = await pool.query(
        "select count(*)::int as n from project_work_items where project_id=$1",
        [projectId]
      );
      expect(initialItems.rows[0]?.n).toBe(1);
      const unverified = await send(finishPath, {
        teamBackendId: backendId,
        stageIds: [stageId]
      });
      expect(unverified.statusCode).toBeGreaterThanOrEqual(400);
      const stillLinked = await pool.query(
        "select workspace_project_id from projects where id=$1",
        [projectId]
      );
      expect(stillLinked.rows[0]?.workspace_project_id).toBe(
        ids.workspaceProject
      );
      // The Team leave committed but its response was lost. No finish call or
      // in-memory stage receipt survives: normal Project reconciliation must
      // find the durable stage and recover only after a verified tombstone.
      tombstoneReady = true;
      lifecycleActive = false;
      const callsBeforeRecovery = teamCalls.length;
      const applied = await send(
        `/v1/local-edge/projects/${projectId}/workspace-project-reconcile`,
        {}
      );
      expect(applied.statusCode, applied.body).toBe(200);
      expect(applied.json()).toMatchObject({
        projectId,
        cleared: true,
        stageId
      });
      expect(teamCalls.slice(callsBeforeRecovery)).toContain(
        `/v1/workspace-projects/${ids.workspaceProject}/tombstone-proof`
      );
      expect(
        teamCalls
          .slice(callsBeforeRecovery)
          .every((path) => !path.endsWith("/leave"))
      ).toBe(true);
      const after = await pool.query(
        "select workspace_project_id from projects where id=$1",
        [projectId]
      );
      expect(after.rows[0]?.workspace_project_id).toBeNull();
      const copied = await pool.query(
        "select count(*)::int as n from project_work_items where project_id=$1 and origin='team_copy_back'",
        [projectId]
      );
      expect(copied.rows[0]?.n).toBe(51);
      expect(
        (
          await pool.query(
            "select id,title from project_decks where owner_user_id=$1 and project_id=$2 and deleted_at is null",
            [ids.personalUser, projectId]
          )
        ).rows
      ).toEqual([{ id: deckIds.personalDeck, title: "Team-edited Deck" }]);
      expect(
        (
          await pool.query(
            "select id,question,answer,source_ref from deck_cards where owner_user_id=$1 and deck_id=$2 and deleted_at is null",
            [ids.personalUser, deckIds.personalDeck]
          )
        ).rows
      ).toEqual([
        {
          id: deckIds.personalCard,
          question: "Team-edited question",
          answer: "Team-edited answer",
          source_ref: "Notes p. 2"
        }
      ]);
      expect(
        (
          await pool.query(
            "select deck_id,card_id,box,misses,team_backend_id,workspace_project_id from deck_card_progress where owner_user_id=$1 and personal_project_id=$2",
            [ids.personalUser, projectId]
          )
        ).rows
      ).toMatchObject([
        {
          deck_id: deckIds.personalDeck,
          card_id: deckIds.personalCard,
          box: 4,
          misses: 2,
          team_backend_id: null,
          workspace_project_id: null
        }
      ]);
      const receipt = await pool.query(
        `select owner_user_id,personal_project_id,team_backend_id,
                workspace_project_id,reason
           from personal_workspace_project_reconciliations
          where personal_project_id=$1`,
        [projectId]
      );
      expect(receipt.rows).toEqual([
        {
          owner_user_id: ids.personalUser,
          personal_project_id: projectId,
          team_backend_id: backendId,
          workspace_project_id: ids.workspaceProject,
          reason: "copy_back"
        }
      ]);
      const retry = await send(finishPath, {
        teamBackendId: backendId,
        stageIds: [stageId]
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({
        completed: [{ stageId, alreadyApplied: true }]
      });
      expect(
        (
          await pool.query(
            "select count(*)::int as n from project_decks where owner_user_id=$1 and project_id=$2 and deleted_at is null",
            [ids.personalUser, projectId]
          )
        ).rows[0]?.n
      ).toBe(1);
      expect(
        (
          await pool.query(
            `select count(*)::int as n
               from personal_workspace_project_reconciliations
              where personal_project_id=$1`,
            [projectId]
          )
        ).rows[0]?.n
      ).toBe(1);
    });
  }
);

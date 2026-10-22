import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { deriveLocalProjectId, hmacProjectValue } from "@koed/shared";
import { createLocalProjectAssociationService } from "../../../../packages/mcp-server/src/local-project-association.js";
import type { Hq713Actor, Hq713Fixture } from "./hq713-fixture.js";

/**
 * Associate a captured Codex session through the production local watcher
 * service. Only the disposable local catalog and source file are bootstrapped;
 * Project association and confirmation run through the actual service.
 */
export async function associateCapturedSession(
  fixture: Pick<Hq713Fixture, "personalDb" | "personalDatabaseUrl">,
  actor: Hq713Actor,
  captured: { sessionId?: string; externalSessionId: string },
  targetProjectId: string,
  createAfterPrepare?: () => Promise<string>
): Promise<string> {
  assert.equal(
    captured.sessionId === undefined,
    createAfterPrepare !== undefined,
    "Capture association must have exactly one Session creation order"
  );
  const folder = join(actor.koedHome, "capture-projects", targetProjectId);
  await mkdir(folder, { recursive: true });
  // The disposable fixture home sits inside the repository's scratch folder.
  // Give it its own checkout identity so production checkout verification does
  // not mistake the parent repository for the captured Project.
  execFileSync("git", ["init", "-q", folder], { timeout: 5_000 });
  const catalogPath = join(actor.koedHome, "config", "projects.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
    schemaVersion: number;
    deviceSaltId?: string;
    projects: Array<Record<string, unknown>>;
  };
  const salt = catalog.deviceSaltId ?? randomBytes(32).toString("hex");
  const localProjectId = deriveLocalProjectId({
    salt,
    cwd: folder,
    projectRoot: folder
  });
  catalog.deviceSaltId = salt;
  if (
    !catalog.projects.some(
      (project) => project.localProjectId === localProjectId
    )
  ) {
    const timestamp = new Date().toISOString();
    catalog.projects.push({
      schemaVersion: 1,
      discoveredAt: timestamp,
      lastSeenAt: timestamp,
      localProjectId,
      displayName: basename(folder),
      path: {
        cwd: folder,
        projectRoot: folder,
        basename: basename(folder),
        localPathHash: hmacProjectValue(salt, folder)
      },
      packages: []
    });
    await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`);
  }
  const personalDatabaseUrl = fixture.personalDatabaseUrl(actor);
  const apiToken = actor.personalTokenAuthorization.replace(/^Bearer\s+/i, "");
  assert.notEqual(apiToken, actor.personalTokenAuthorization);
  const environment = {
    ...process.env,
    KOED_RUNTIME_MODE: "local-personal",
    KOED_HOME: actor.koedHome,
    KOED_DEVICE_PROOF_DIR: join(`${actor.koedHome}-proof-root`, "proof"),
    MEMORY_API_URL: actor.personal.baseUrl,
    MEMORY_API_TOKEN: apiToken,
    DATABASE_URL: personalDatabaseUrl
  };
  const service = createLocalProjectAssociationService({
    koedHome: actor.koedHome,
    captureClient: { apiUrl: actor.personal.baseUrl, apiToken },
    environment
  });
  assert.ok(
    service,
    "Verified Personal capture association service is unavailable"
  );
  try {
    const prepared = await service.prepare({
      sourceKind: "codex",
      externalSessionId: captured.externalSessionId,
      sourceProjectPath: folder,
      localProjectId,
      requiredSourceOffset: 0
    });
    assert.equal(prepared, true, "Actual local Project checkout must prepare");
    // The future-policy proof is stamped only when this verified prepare
    // predates the captured Session. The ordinary fixture path supplies its
    // existing Session and keeps its original ordering.
    const sessionId = captured.sessionId ?? (await createAfterPrepare!());
    await actor.personal.request("PUT", "/v1/capture-policies", {
      body: {
        targetType: "project",
        projectId: folder,
        captureState: "enabled",
        visibility: "personal"
      },
      expectedStatus: 200
    });
    const sourcePath = join(folder, `hq713-${randomUUID()}.jsonl`);
    const content = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "session_meta",
      payload: { id: captured.externalSessionId, cwd: folder }
    })}\n`;
    await writeFile(sourcePath, content);
    const now = new Date().toISOString();
    const registered = await actor.personalTokenClient.request<{
      session: { id: string };
      artifact: {
        id: string;
        externalSessionId: string;
        providerCursorOffset: number;
      };
    }>("POST", "/v1/conversation-source-artifacts", {
      body: {
        sourceSession: {
          externalSessionId: captured.externalSessionId,
          sourceRuntime: "codex",
          captureMethod: "api",
          cwd: folder,
          idempotencyKey: `hq713-artifact-${captured.externalSessionId}`,
          metadata: { fixture: "hq713", targetProjectId }
        },
        sourceKind: "codex",
        externalSessionId: captured.externalSessionId,
        sourceFingerprint: createHash("sha256").update(content).digest("hex"),
        artifactFormat: "codex_rollout_jsonl",
        artifactFormatVersion: 1,
        journalStartOffset: 0,
        journalStartLine: 0,
        liveStartOffset: 0,
        liveStartLine: 0,
        currentSourceLength: Buffer.byteLength(content),
        sourceCreatedAt: now,
        sourceModifiedAt: now,
        redactedSourceLabel: basename(sourcePath)
      },
      expectedStatus: 200
    });
    assert.equal(registered.body.session.id, sessionId);
    assert.equal(
      registered.body.artifact.externalSessionId,
      captured.externalSessionId
    );
    // Confirm the owner's existing Personal Project before completion can
    // replay the candidate. An unconfirmed completion legitimately creates a
    // new Project for this checkout, which cannot then be silently remapped.
    await service.confirm({
      localProjectId,
      choice: { projectId: targetProjectId }
    });
    await service.complete("codex", captured.externalSessionId, {
      id: registered.body.artifact.id,
      sessionId,
      externalSessionId: captured.externalSessionId,
      providerCursorOffset: registered.body.artifact.providerCursorOffset
    });
    await service.replay();
    const association = await fixture.personalDb(actor).query<{
      project_id: string;
      association_state: string;
    }>(
      `select project_id,association_state from project_local_contexts
        where owner_user_id=$1 and device_id=$2 and local_project_id=$3`,
      [actor.id, actor.deviceId, localProjectId]
    );
    assert.deepEqual(association.rows, [
      {
        project_id: targetProjectId,
        association_state: "resolved"
      }
    ]);
    const session = await fixture.personalDb(actor).query<{
      automatic_personal_project_id: string | null;
    }>("select automatic_personal_project_id from sessions where id=$1 and owner_user_id=$2", [sessionId, actor.id]);
    assert.equal(
      session.rows[0]?.automatic_personal_project_id,
      targetProjectId
    );
    return sessionId;
  } finally {
    await service.close();
  }
}

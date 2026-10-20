import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PdsRelayClient,
  canonicalizePdsJson,
  personalSourceContextSnapshotSchema,
  verifyAndDecryptPdsSessionSourcePackage,
  type PdsConversationSourceItem
} from "@koed/shared";
import type { PdsClosureSource } from "@koed/db";
import { personalSourceDeviceFixture } from "../../../../packages/db/tests/fixtures/personal-source-device.js";
import { createReloadablePdsSecureKeyProviderFromEnvironment } from "./secure-runtime.js";

describe("capability-gated source publication", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("negotiates before building new formats and checks cached support without a relay call inside publication", async () => {
    const fixture = personalSourceDeviceFixture(),
      userId = randomUUID(),
      logicalSessionId = randomUUID(),
      now = new Date().toISOString();
    const secret = {
      version: 1,
      userId,
      relayUrl: "https://relay.fixture",
      groupId: fixture.groupId,
      device: {
        id: fixture.origin.deviceId,
        originDeploymentId: fixture.origin.deploymentId,
        signingKeyId: fixture.origin.signingKeyId,
        signingPrivateSeed: fixture.origin.signing.privateSeed,
        kemKeyId: fixture.origin.kemKeyId,
        kemPrivateSeed: fixture.origin.kem.privateSeed
      },
      authority: {
        keyId: fixture.authorityKeyId,
        publicKey: fixture.authorityPublicKey,
        head: fixture.authorityHead
      },
      recovery: {
        signingKeyId: fixture.receiver.signingKeyId,
        signingPublicKey: fixture.receiver.signing.publicKey
      },
      certificate: fixture.origin.certificate,
      recipientCertificates: fixture.certificates,
      groupSecrets: {
        currentEpoch: fixture.epoch,
        contentKey: randomBytes(32).toString("base64url"),
        sourceFingerprintKey: fixture.sourceFingerprintKey,
        tombstoneFloorKey: fixture.tombstoneFloorKey,
        projectAliasKey: fixture.projectAliasKey
      }
    };
    const provider = createReloadablePdsSecureKeyProviderFromEnvironment(
      { PDS_SECRET_PROVIDER: "headless", PDS_RUNTIME_SECRET_REF: "fixture" },
      { resolveHeadlessSecret: async () => JSON.stringify(secret) }
    );
    const context = await provider!.getSourceContext({
      userId,
      groupId: fixture.groupId
    });
    if (!context) throw new Error("Missing fixture source key context");
    const assignment = {
      revision: 1,
      original: { state: "unresolved", reason: "historical_unresolved" },
      correction: { state: "original" }
    };
    const sourceContext = personalSourceContextSnapshotSchema.parse({
      version: "1",
      context: {
        version: 1,
        source: {
          ownerUserId: userId,
          originatingDeploymentId: fixture.origin.deploymentId,
          originatingDeviceId: fixture.origin.deviceId,
          logicalSessionId
        },
        git: assignment,
        folder: assignment
      },
      git: {
        head: "git_original",
        revisions: [{ revisionId: "git_original", replaces: [], assignment }]
      },
      folder: {
        head: "folder_original",
        revisions: [{ revisionId: "folder_original", replaces: [], assignment }]
      }
    });
    const source: PdsClosureSource = {
      sourceContext,
      groupDbId: randomUUID(),
      groupId: fixture.groupId,
      sessionId: randomUUID(),
      logicalSessionId,
      externalSessionId: randomUUID(),
      forkedFromExternalThreadId: null,
      sourceRuntime: "codex",
      sourceAdapter: "codex",
      sourceAdapterVersion: "codex-transcript-v1",
      sourceCreatedAt: now,
      items: []
    };
    const items: PdsConversationSourceItem[] = [
      {
        sourceNativeItemId: "item-one",
        sequence: "0",
        sourceTimestamp: now,
        observedAt: now,
        actor: "user",
        type: "user_message",
        content: "Source publication capability fixture",
        metadata: {}
      }
    ];
    const capabilities = vi
      .spyOn(PdsRelayClient.prototype, "configurationCapabilities")
      .mockResolvedValue([]);
    expect(context.sourceContextVersion).toBe("1");
    await expect(
      context.prepareSourceContextPublication!()
    ).rejects.toMatchObject({
      code: "peer_capability_required",
      statusCode: 409
    });
    await expect(
      context.buildClosedSessionPackage({
        source,
        items,
        sourceSequence: "1",
        closedAt: new Date()
      })
    ).rejects.toMatchObject({ code: "peer_capability_required" });
    capabilities.mockResolvedValue([fixture.capability(fixture.receiver)]);
    await context.prepareSourceContextPublication!();
    capabilities.mockImplementation(() => {
      throw new Error(
        "Relay access must precede the database publication transaction"
      );
    });
    const closed = await context.buildClosedSessionPackage({
      source,
      items,
      sourceSequence: "1",
      closedAt: new Date()
    });
    const decode = (pkg: typeof closed.package) =>
      verifyAndDecryptPdsSessionSourcePackage(canonicalizePdsJson(pkg), {
        runtime: fixture.runtime(fixture.origin, fixture.receiver),
        recipientKemPrivateKey: fixture.receiver.kem.privateSeed
      });
    expect(decode(closed.package).version).toBe("5");
    const checkpoint = await context.buildCompletedTurnCheckpointPackage({
      source,
      items,
      sourceSequence: "2",
      checkpoint: { version: "1", ordinal: "0", previousClosureHash: null }
    });
    expect(decode(checkpoint.package).version).toBe("6");
    expect(capabilities).toHaveBeenCalledTimes(2);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 181_000));
    await expect(
      context.buildClosedSessionPackage({
        source,
        items,
        sourceSequence: "3",
        closedAt: new Date()
      })
    ).rejects.toMatchObject({ code: "peer_capability_required" });
  });
});

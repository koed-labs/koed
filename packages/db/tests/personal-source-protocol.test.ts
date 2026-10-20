import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizePdsJson,
  encodePdsPersonalSourceContextSnapshot,
  personalSourceContextSnapshotSchema,
  requirePdsConfigurationCapability,
  signPersonalConfigurationRecord,
  verifyPersonalConfigurationRecord,
  PERSONAL_CONFIGURATION_PROTOCOL
} from "@koed/shared";
import { personalSourceDeviceFixture } from "./fixtures/personal-source-device.js";

describe("Personal source protocol boundaries", () => {
  it("requires current signed support from every recipient and rejects duplicate, altered, stale, or wrong-head advertisements", () => {
    const fixture = personalSourceDeviceFixture(),
      capability = fixture.capability(fixture.receiver);
    const authority = {
      groupId: fixture.groupId,
      authorityHead: fixture.authorityHead,
      currentEpoch: fixture.epoch,
      authorityPublicKey: fixture.authorityPublicKey,
      authorityKeyId: fixture.authorityKeyId,
      activeCertificates: fixture.certificates,
      intendedRecipientDeviceIds: [fixture.receiver.deviceId],
      feature: "source_context_v1" as const
    };
    expect(() =>
      requirePdsConfigurationCapability({ ...authority, records: [capability] })
    ).not.toThrow();
    for (const records of [
      [],
      [capability, capability],
      [
        {
          ...capability,
          canonicalAdvertisement: canonicalizePdsJson({
            ...(JSON.parse(capability.canonicalAdvertisement) as Record<
              string,
              unknown
            >),
            features: ["project_membership_v1"]
          })
        }
      ]
    ])
      expect(() =>
        requirePdsConfigurationCapability({ ...authority, records })
      ).toThrow("Personal synchronization is pending");
    expect(() =>
      requirePdsConfigurationCapability({
        ...authority,
        records: [capability],
        now: new Date(Date.now() + 181_000)
      })
    ).toThrow("Personal synchronization is pending");
    expect(() =>
      requirePdsConfigurationCapability({
        ...authority,
        records: [capability],
        authorityHead: randomBytes(32).toString("base64url")
      })
    ).toThrow("Personal synchronization is pending");
  });
  it("binds the independent record signature to its group and author and rejects modified or incomplete history", () => {
    const fixture = personalSourceDeviceFixture(),
      assignment = {
        revision: 1,
        original: { state: "unresolved", reason: "historical_unresolved" },
        correction: { state: "original" }
      };
    const snapshot = encodePdsPersonalSourceContextSnapshot(
      personalSourceContextSnapshotSchema.parse({
        version: "1",
        context: {
          version: 1,
          source: {
            ownerUserId: randomUUID(),
            originatingDeploymentId: fixture.origin.deploymentId,
            originatingDeviceId: fixture.origin.deviceId,
            logicalSessionId: "opaque/逻辑/source"
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
          revisions: [
            { revisionId: "folder_original", replaces: [], assignment }
          ]
        }
      })
    );
    const fields = {
      protocol: PERSONAL_CONFIGURATION_PROTOCOL,
      groupId: fixture.groupId,
      authorDeviceId: fixture.origin.deviceId,
      authorSigningKeyId: fixture.origin.signingKeyId,
      payload: { kind: "source_context" as const, snapshot }
    };
    const record = signPersonalConfigurationRecord(
      fields,
      fixture.origin.signing.privateKey
    );
    const author = {
      groupId: fixture.groupId,
      deviceId: fixture.origin.deviceId,
      signingKeyId: fixture.origin.signingKeyId,
      publicKey: fixture.origin.signing.publicKey
    };
    expect(verifyPersonalConfigurationRecord(record, author)).toEqual(record);
    expect(() =>
      verifyPersonalConfigurationRecord(record, {
        ...author,
        groupId: randomUUID()
      })
    ).toThrow("PdsCryptoConfigurationAuthorityError");
    expect(() =>
      verifyPersonalConfigurationRecord(record, {
        ...author,
        publicKey: fixture.receiver.signing.publicKey
      })
    ).toThrow("PdsCryptoConfigurationSignatureError");
    expect(() =>
      verifyPersonalConfigurationRecord(
        {
          ...record,
          revision: {
            ...record.revision,
            payload: {
              ...record.revision.payload,
              snapshot: {
                ...snapshot,
                context: {
                  ...snapshot.context,
                  source: {
                    ...snapshot.context.source,
                    logicalSessionId: "changed"
                  }
                }
              }
            }
          }
        },
        author
      )
    ).toThrow();
    const incomplete = {
      ...snapshot,
      git: {
        ...snapshot.git,
        revisions: snapshot.git.revisions.map((revision) => ({
          ...revision,
          replaces: ["unseen_parent"]
        }))
      }
    };
    expect(() =>
      signPersonalConfigurationRecord(
        {
          ...fields,
          payload: { kind: "source_context", snapshot: incomplete }
        },
        fixture.origin.signing.privateKey
      )
    ).toThrow("Configuration history is incomplete or invalid");
  });
});

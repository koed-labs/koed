import type pg from "pg";
import { expect, it, vi } from "vitest";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  type TeamRepositorySnapshot
} from "@koed/shared";
import {
  readOwnerPrivateRepositorySnapshotMetadata,
  writeOwnerPrivateRepositorySnapshot
} from "../src/owner-private-repository-snapshot.js";

it("stores raw Project labels only in an owner-private envelope bound to the Session and source owner", async () => {
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 79).toString("base64")
  );
  const query = vi.fn<
    (
      sql: string,
      values: unknown[]
    ) => Promise<{ rows: unknown[]; rowCount: number }>
  >(async () => ({
    rows: [],
    rowCount: 1
  }));
  const client = { query } as unknown as pg.PoolClient;
  const binding = {
    sessionId: "session-one",
    ownerUserId: "receiver-user",
    ownerPrincipalId: "source-owner"
  };
  const snapshot: TeamRepositorySnapshot = {
    version: 1,
    classification: "portable_repository",
    fingerprint: "gr_source",
    label: "Confidential Project Name",
    branchObservation: "private-release-branch"
  };
  await writeOwnerPrivateRepositorySnapshot(
    client,
    provider,
    binding,
    snapshot
  );
  const stored = JSON.parse(query.mock.calls[0]![1][2] as string) as {
    repositorySnapshot: TeamRepositorySnapshot;
    repositorySnapshotMetadataEnvelope: unknown;
  };
  expect(stored.repositorySnapshot).toEqual({
    ...snapshot,
    label: null,
    branchObservation: null
  });
  expect(JSON.stringify(stored)).not.toMatch(
    /Confidential Project Name|private-release-branch/
  );
  expect(
    await readOwnerPrivateRepositorySnapshotMetadata(
      provider,
      binding,
      stored.repositorySnapshotMetadataEnvelope,
      stored.repositorySnapshot
    )
  ).toEqual(snapshot);
  const decrypt = vi.fn(provider.decrypt.bind(provider));
  await expect(
    readOwnerPrivateRepositorySnapshotMetadata(
      { ...provider, decrypt },
      { ...binding, sessionId: "other-session" },
      stored.repositorySnapshotMetadataEnvelope,
      stored.repositorySnapshot
    )
  ).rejects.toThrow("binding changed");
  expect(decrypt).not.toHaveBeenCalled();
  await expect(
    readOwnerPrivateRepositorySnapshotMetadata(
      provider,
      binding,
      stored.repositorySnapshotMetadataEnvelope,
      { ...stored.repositorySnapshot, fingerprint: "gr_other" }
    )
  ).rejects.toThrow("disagree");
});

it("clears stale disclosure metadata when the source becomes unresolved", async () => {
  const provider = createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 80).toString("base64")
  );
  const query = vi.fn<
    (
      sql: string,
      values: unknown[]
    ) => Promise<{ rows: unknown[]; rowCount: number }>
  >(async () => ({
    rows: [],
    rowCount: 1
  }));
  await writeOwnerPrivateRepositorySnapshot(
    { query } as unknown as pg.PoolClient,
    provider,
    {
      sessionId: "session-one",
      ownerUserId: "receiver-user",
      ownerPrincipalId: "source-owner"
    },
    {
      version: 1,
      classification: "unresolved",
      fingerprint: null,
      label: null,
      branchObservation: null
    }
  );
  expect(query.mock.calls[0]![0]).toContain(
    "metadata-'repositorySnapshotMetadataEnvelope'"
  );
  expect(JSON.parse(query.mock.calls[0]![1][2] as string)).toEqual({
    repositorySnapshot: {
      version: 1,
      classification: "unresolved",
      fingerprint: null,
      label: null,
      branchObservation: null
    }
  });
});

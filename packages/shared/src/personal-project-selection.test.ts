import { generateKeyPairSync } from "node:crypto";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalizePdsJson } from "./personal-device-sync-jcs.js";
import { pdsEd25519PrivateKey } from "./personal-device-sync.js";
import { expect, it } from "vitest";
import {
  PDS_PROJECT_SELECTION_PROTOCOL,
  resolvePdsProjectSelection,
  requireReviewedProjectSelectionHeads,
  associatedSelectionFromPdsState,
  signPdsProjectSelection,
  verifyPdsProjectSelection,
  pdsProjectSelectionPackageId,
  type PdsProjectSelectionRevision
} from "./personal-project-selection.js";

const scope = {
  groupId: "group",
  associationId: "association",
  selectionId: "selection"
};
it("matches immutable signature, canonical-record and transport identity vectors", () => {
  const vector = JSON.parse(
    readFileSync(
      new URL(
        "../test-fixtures/personal-project-selection-v1.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as {
    publicKey: string;
    privateSeed: string;
    record: { revision: PdsProjectSelectionRevision; signature: string };
    canonicalRecord: string;
    recordHash: string;
    transportId: string;
    packageId: string;
  };
  expect(
    verifyPdsProjectSelection(vector.record, {
      groupId: vector.record.revision.groupId,
      deviceId: vector.record.revision.authorDeviceId,
      signingKeyId: vector.record.revision.authorSigningKeyId,
      publicKey: vector.publicKey
    })
  ).toEqual(vector.record);
  expect(canonicalizePdsJson(vector.record)).toBe(vector.canonicalRecord);
  expect(
    signPdsProjectSelection(
      vector.record.revision,
      pdsEd25519PrivateKey(vector.privateSeed, vector.publicKey)
    )
  ).toEqual(vector.record);
  expect(
    createHash("sha256").update(vector.canonicalRecord).digest("base64url")
  ).toBe(vector.recordHash);
  expect(
    pdsProjectSelectionPackageId(vector.recordHash, vector.transportId)
  ).toBe(vector.packageId);
  expect(
    pdsProjectSelectionPackageId(
      vector.recordHash,
      Buffer.alloc(32, 10).toString("base64url")
    )
  ).not.toBe(vector.packageId);
});
const revision = (
  revisionId: string,
  replaces: string[] = [],
  anchorFingerprint: string | null = "gr_first",
  authorDeviceId = "deviceA"
): PdsProjectSelectionRevision => ({
  protocol: PDS_PROJECT_SELECTION_PROTOCOL,
  ...scope,
  revisionId,
  authorDeviceId,
  authorSigningKeyId: `${authorDeviceId}_key`,
  replaces,
  operation:
    anchorFingerprint === null
      ? { kind: "delete" }
      : { kind: "set", anchorFingerprint }
});

it("authenticates configuration scope, author and replaced revisions", () => {
  const keys = generateKeyPairSync("ed25519");
  const record = signPdsProjectSelection(revision("r1"), keys.privateKey);
  const author = {
    groupId: scope.groupId,
    deviceId: "deviceA",
    signingKeyId: "deviceA_key",
    publicKey: keys.publicKey
  };
  expect(verifyPdsProjectSelection(record, author)).toEqual(record);
  expect(() =>
    verifyPdsProjectSelection(record, { ...author, groupId: "other" })
  ).toThrow("unauthorized");
  expect(() =>
    verifyPdsProjectSelection(record, { ...author, deviceId: "deviceB" })
  ).toThrow("unauthorized");
  expect(() =>
    verifyPdsProjectSelection(
      { ...record, revision: { ...record.revision, replaces: ["missing"] } },
      author
    )
  ).toThrow("signature");
  expect(() =>
    verifyPdsProjectSelection(record, {
      ...author,
      publicKey: generateKeyPairSync("ed25519").publicKey
    })
  ).toThrow("signature");
});

it("retains a deletion across offline out-of-order replay and requires explicit recreation", () => {
  const set = revision("r1");
  const remove = revision("r2", ["r1"], null);
  expect(resolvePdsProjectSelection(scope, [remove])).toMatchObject({
    state: "incomplete",
    missingRevisions: ["r1"]
  });
  for (const values of [
    [set, remove, set],
    [remove, set, remove]
  ]) {
    const state = resolvePdsProjectSelection(scope, values);
    expect(state).toMatchObject({ state: "deleted", heads: ["r2"] });
    expect(
      associatedSelectionFromPdsState(scope.associationId, state)
    ).toBeUndefined();
  }
  const recreate = revision("r3", ["r2"], "gr_second");
  expect(
    resolvePdsProjectSelection(scope, [recreate, remove, set])
  ).toMatchObject({
    state: "selected",
    heads: ["r3"],
    anchorFingerprint: "gr_second"
  });
  expect(
    resolvePdsProjectSelection(scope, [set, remove, revision("unrelated")])
      .state
  ).toBe("conflict");
});

it.each(["gr_second", null])(
  "keeps concurrent set/set and set/delete unresolved (%s)",
  (choice) => {
    const root = revision("r1");
    const a = revision("rA", ["r1"], "gr_first");
    const b = revision("rB", ["r1"], choice, "deviceB");
    const online = resolvePdsProjectSelection(scope, [root, a, b]);
    const offline = resolvePdsProjectSelection(scope, [b, a, root, b]);
    expect(online).toEqual(offline);
    expect(online).toMatchObject({ state: "conflict", heads: ["rA", "rB"] });
    expect(
      associatedSelectionFromPdsState(scope.associationId, online)?.selection
        .state
    ).toBe("conflict");
    const reviewed = requireReviewedProjectSelectionHeads(online, ["rB", "rA"]);
    const resolved = revision("rResolved", reviewed, choice);
    expect(
      resolvePdsProjectSelection(scope, [resolved, b, root, a]).state
    ).toBe(choice ? "selected" : "deleted");
    const newCompetitor = revision("rC", ["r1"], "gr_third", "deviceC");
    const changed = resolvePdsProjectSelection(scope, [
      root,
      a,
      b,
      newCompetitor
    ]);
    expect(() =>
      requireReviewedProjectSelectionHeads(changed, reviewed)
    ).toThrow("changed");
    expect(
      resolvePdsProjectSelection(scope, [root, a, b, resolved, newCompetitor])
        .state
    ).toBe("conflict");
  }
);

it("rejects reused revisions, causal cycles and cross-association records", () => {
  expect(() =>
    resolvePdsProjectSelection(scope, [
      revision("r1"),
      revision("r1", [], "gr_other")
    ])
  ).toThrow("reused");
  expect(() =>
    resolvePdsProjectSelection(scope, [
      revision("r1", ["r2"]),
      revision("r2", ["r1"])
    ])
  ).toThrow("cycle");
  expect(() =>
    resolvePdsProjectSelection(scope, [
      { ...revision("r1"), associationId: "other" }
    ])
  ).toThrow("scope");
  expect(() =>
    requireReviewedProjectSelectionHeads(
      resolvePdsProjectSelection(scope, [revision("r2", ["r1"])]),
      ["r2"]
    )
  ).toThrow("incomplete");
});

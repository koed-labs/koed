import { describe, expect, it } from "vitest";

import {
  sourceControlConnectionSchema,
  sourceControlOperationSchema,
  sourceControlRemoteSchema
} from "./source-control.js";

const base = {
  contractVersion: 1,
  executionId: "11111111-1111-4111-8111-111111111111",
  executionGeneration: 1,
  remoteIdentityHash: "a".repeat(64),
  expectedHeadObjectId: "b".repeat(40),
  credentialGeneration: 2,
  idempotencyKey: "source-control:fixture-operation"
};

describe("source-control contract", () => {
  it("accepts explicit fast-forward and current-HEAD push operations", () => {
    expect(
      sourceControlOperationSchema.parse({
        ...base,
        kind: "fast_forward",
        remoteName: "origin",
        remoteBranch: "main",
        expectedRemoteObjectId: "c".repeat(40)
      })
    ).toMatchObject({ kind: "fast_forward", remoteBranch: "main" });
    expect(
      sourceControlOperationSchema.parse({
        ...base,
        kind: "push",
        remoteName: "origin",
        targetBranch: "feature/example",
        expectedRemoteObjectId: null
      })
    ).not.toHaveProperty("sourceRef");
  });

  it("rejects arbitrary source refs and credential-shaped remote fields", () => {
    expect(() =>
      sourceControlOperationSchema.parse({
        ...base,
        kind: "push",
        remoteName: "origin",
        sourceRef: "refs/heads/secret",
        targetBranch: "main",
        expectedRemoteObjectId: null
      })
    ).toThrow();
    expect(() =>
      sourceControlRemoteSchema.parse({
        remoteName: "origin",
        provider: "github",
        host: "github.com",
        transport: "https",
        locator: { namespace: "acme", repository: "repo", project: null },
        remoteIdentityHash: "a".repeat(64),
        connectionId: null,
        credentialGeneration: null,
        connectionState: "connection_required",
        capabilities: [],
        url: "https://token@github.com/acme/repo.git"
      })
    ).toThrow();
  });

  it("requires opaque secret references and canonical HTTPS API origins", () => {
    const connection = {
      id: "22222222-2222-4222-8222-222222222222",
      provider: "gitlab",
      host: "git.example.test",
      apiOrigin: "https://git.example.test/api/v4",
      accountLabel: "Work",
      credentialReference: "source-control:work",
      credentialGeneration: 1,
      state: "active",
      capabilities: ["repository_read"]
    };
    expect(sourceControlConnectionSchema.parse(connection)).toEqual(connection);
    expect(() =>
      sourceControlConnectionSchema.parse({
        ...connection,
        apiOrigin: "https://token@git.example.test/api/v4"
      })
    ).toThrow();
    expect(() =>
      sourceControlConnectionSchema.parse({
        ...connection,
        credentialReference: "env://GITLAB_TOKEN"
      })
    ).toThrow();
  });
});

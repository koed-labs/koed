import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createApiTokenBootstrap,
  formatCreateApiTokenResult,
  formatCliError,
  formatListApiTokenResult,
  formatRevokeApiTokenResult,
  hashApiToken,
  listApiTokenBootstrap,
  parseCreateApiTokenArgs,
  parseListApiTokenArgs,
  revokeApiTokenBootstrap
} from "./api-token-bootstrap-lib.mjs";

const deterministicRandomBytes = () => Buffer.alloc(32, 7);

const createFakeRepo = ({ existingUser = null } = {}) => {
  const state = {
    users: existingUser ? [existingUser] : [],
    createdTokens: [],
    auditEvents: []
  };

  return {
    state,
    async findUserByEmail(email) {
      return state.users.find((user) => user.email === email) ?? null;
    },
    async createUser(input) {
      const user = {
        id: `user-${state.users.length + 1}`,
        email: input.email,
        displayName: input.displayName,
        passwordHash: input.passwordHash
      };
      state.users.push(user);
      return user;
    },
    async createApiToken(input) {
      const token = {
        id: `token-${state.createdTokens.length + 1}`,
        ownerUserId: input.ownerUserId,
        name: input.name,
        tokenHash: input.tokenHash,
        tokenPrefix: input.tokenPrefix,
        scopes: input.scopes
      };
      state.createdTokens.push(token);
      if (input.audit) {
        state.auditEvents.push({
          actorUserId: input.audit.actorUserId ?? null,
          ownerUserId: input.ownerUserId,
          visibility: "personal",
          action: "api_token.created",
          targetTable: "api_tokens",
          targetId: token.id,
          metadata: {
            actorType: input.audit.actorType,
            name: token.name,
            tokenPrefix: token.tokenPrefix,
            scopes: token.scopes ?? []
          }
        });
      }
      return token;
    },
    async listApiTokens(userId) {
      return state.createdTokens.filter(
        (token) => token.ownerUserId === userId && !token.revokedAt
      );
    },
    async revokeApiToken(userId, tokenId, audit) {
      const token = state.createdTokens.find(
        (item) => item.ownerUserId === userId && item.id === tokenId
      );
      if (!token || token.revokedAt) {
        return false;
      }
      token.revokedAt = new Date().toISOString();
      if (audit) {
        state.auditEvents.push({
          actorUserId: audit.actorUserId ?? null,
          ownerUserId: userId,
          visibility: "personal",
          action: "api_token.revoked",
          targetTable: "api_tokens",
          targetId: tokenId,
          metadata: { actorType: audit.actorType }
        });
      }
      return true;
    }
  };
};

test("parses required owner email and default token name", () => {
  assert.deepEqual(
    parseCreateApiTokenArgs(["--owner-email", "USER@EXAMPLE.COM"]),
    {
      ownerEmail: "user@example.com",
      name: "Client Integration",
      help: false
    }
  );
});

test("list owner email missing value reports list usage", () => {
  assert.throws(
    () => parseListApiTokenArgs(["--owner-email"]),
    (error) => {
      assert.match(error.message, /--owner-email requires a value/);
      assert.match(
        error.message,
        /Usage: pnpm api-token:list --owner-email <email>/
      );
      assert.doesNotMatch(error.message, /--token-id/);
      return true;
    }
  );
});

test("creates a passwordless owner when none exists", async () => {
  const repo = createFakeRepo();
  const result = await createApiTokenBootstrap({
    repo,
    environment: {
      DATABASE_URL: "postgres://local",
      API_TOKEN_PEPPER: "pepper"
    },
    argv: ["--owner-email", "local@koed.ai", "--name", "Codex"],
    randomBytes: deterministicRandomBytes
  });

  assert.equal(result.ownerCreated, true);
  assert.deepEqual(repo.state.users, [
    {
      id: "user-1",
      email: "local@koed.ai",
      displayName: null,
      passwordHash: null
    }
  ]);
  assert.equal(repo.state.createdTokens[0].ownerUserId, "user-1");
  assert.equal(repo.state.createdTokens[0].name, "Codex");
  assert.equal(
    repo.state.createdTokens[0].tokenHash.includes(result.token),
    false
  );
  assert.equal(
    repo.state.createdTokens[0].tokenHash,
    hashApiToken("pepper", result.token)
  );
  assert.deepEqual(repo.state.auditEvents, [
    {
      actorUserId: null,
      ownerUserId: "user-1",
      visibility: "personal",
      action: "api_token.created",
      targetTable: "api_tokens",
      targetId: "token-1",
      metadata: {
        actorType: "local_operator_script",
        name: "Codex",
        tokenPrefix: result.token.slice(0, 12),
        scopes: []
      }
    }
  ]);
  assert.equal(
    Object.hasOwn(repo.state.auditEvents[0].metadata, "tokenHash"),
    false
  );
});

test("reuses an existing owner by email", async () => {
  const repo = createFakeRepo({
    existingUser: { id: "existing-user", email: "local@koed.ai" }
  });
  const result = await createApiTokenBootstrap({
    repo,
    environment: {
      DATABASE_URL: "postgres://local",
      API_TOKEN_PEPPER: "pepper"
    },
    argv: ["--owner-email=local@koed.ai"],
    randomBytes: deterministicRandomBytes
  });

  assert.equal(result.ownerCreated, false);
  assert.equal(repo.state.users.length, 1);
  assert.equal(repo.state.createdTokens[0].ownerUserId, "existing-user");
});

test("fails clearly when required env vars are missing", async () => {
  const repo = createFakeRepo();

  await assert.rejects(
    () =>
      createApiTokenBootstrap({
        repo,
        environment: { API_TOKEN_PEPPER: "pepper" },
        argv: ["--owner-email", "local@koed.ai"]
      }),
    /Missing required environment value: DATABASE_URL/
  );
});

test("formats blank AggregateError database connection failures", () => {
  const error = new AggregateError([
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:15432"), {
      code: "ECONNREFUSED"
    })
  ]);
  error.code = "ECONNREFUSED";

  const message = formatCliError(error);

  assert.match(message, /Could not connect to Postgres using DATABASE_URL/);
  assert.match(message, /docker compose up postgres/);
  assert.match(message, /connect ECONNREFUSED 127\.0\.0\.1:15432/);
});

test("prints the full token once without exposing the stored hash", async () => {
  const repo = createFakeRepo();
  const result = await createApiTokenBootstrap({
    repo,
    environment: {
      DATABASE_URL: "postgres://local",
      API_TOKEN_PEPPER: "pepper"
    },
    argv: ["--owner-email", "local@koed.ai"],
    randomBytes: deterministicRandomBytes
  });
  const output = formatCreateApiTokenResult(result);

  assert.equal(output.match(/Token: cmt_/g)?.length, 1);
  assert.match(output, new RegExp(`Token: ${result.token}`));
  assert.doesNotMatch(
    output,
    new RegExp(repo.state.createdTokens[0].tokenHash)
  );
});

test("lists active tokens for a passwordless owner", async () => {
  const repo = createFakeRepo({
    existingUser: { id: "existing-user", email: "local@koed.ai" }
  });
  repo.state.createdTokens.push({
    id: "token-1",
    ownerUserId: "existing-user",
    name: "Codex",
    tokenPrefix: "cmt_example",
    createdAt: "2026-05-29T00:00:00.000Z",
    lastUsedAt: null
  });

  const result = await listApiTokenBootstrap({
    repo,
    environment: { DATABASE_URL: "postgres://local" },
    argv: ["--owner-email", "local@koed.ai"]
  });
  const output = formatListApiTokenResult(result);

  assert.match(output, /Active Koed API tokens for local@koed.ai/);
  assert.match(output, /token-1/);
  assert.match(output, /prefix=cmt_example/);
});

test("revokes an active token for a passwordless owner", async () => {
  const repo = createFakeRepo({
    existingUser: { id: "existing-user", email: "local@koed.ai" }
  });
  repo.state.createdTokens.push({
    id: "token-1",
    ownerUserId: "existing-user",
    name: "Codex",
    tokenPrefix: "cmt_example"
  });

  const result = await revokeApiTokenBootstrap({
    repo,
    environment: { DATABASE_URL: "postgres://local" },
    argv: ["--owner-email", "local@koed.ai", "--token-id", "token-1"]
  });
  const output = formatRevokeApiTokenResult(result);

  assert.match(output, /Revoked Koed API token token-1/);
  assert.equal(repo.state.createdTokens[0].revokedAt !== undefined, true);
  assert.deepEqual(repo.state.auditEvents, [
    {
      actorUserId: null,
      ownerUserId: "existing-user",
      visibility: "personal",
      action: "api_token.revoked",
      targetTable: "api_tokens",
      targetId: "token-1",
      metadata: { actorType: "local_operator_script" }
    }
  ]);
});

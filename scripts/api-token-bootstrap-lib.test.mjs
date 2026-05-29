import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createApiTokenBootstrap,
  formatCreateApiTokenResult,
  hashApiToken,
  parseCreateApiTokenArgs
} from "./api-token-bootstrap-lib.mjs";

const deterministicRandomBytes = () => Buffer.alloc(32, 7);

const createFakeRepo = ({ existingUser = null } = {}) => {
  const state = {
    users: existingUser ? [existingUser] : [],
    createdTokens: []
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
      return token;
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

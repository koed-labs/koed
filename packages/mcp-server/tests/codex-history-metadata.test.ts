import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexHistoryMetadataReader } from "../src/codex-history-metadata.js";
import { CodexAppServerClient } from "../src/codex-app-server-runner.js";

const fixture = (
  options: {
    wrongHome?: boolean;
    wrongIdentity?: boolean;
    hydrated?: boolean;
    invalidPage?: "missing-id" | "empty-cursor" | "oversized";
    idleMs?: number;
  } = {}
) => {
  const root = mkdtempSync(path.join(tmpdir(), "koed-history-metadata-"));
  const home = path.join(root, "codex");
  mkdirSync(home, { mode: 0o700 });
  const binary = path.join(root, "metadata-fixture.mjs");
  const log = path.join(root, "requests.jsonl");
  writeFileSync(
    binary,
    `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (!process.argv.includes("features.background_paginated_rollout_migration=false")) process.exit(42);
const options = ${JSON.stringify(options)};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") return;
  if (message.method === "initialize") return send({ id: message.id, result: { codexHome: options.wrongHome ? "/wrong/home" : process.env.CODEX_HOME } });
  if (message.method === "thread/turns/list" && message.params.limit === 1 && message.params.itemsView === "summary") return send({ id: message.id, result: { data: options.invalidPage === "missing-id" ? [{}] : options.invalidPage === "oversized" ? [{id: "one"}, {id: "two"}] : [], nextCursor: options.invalidPage === "empty-cursor" ? "" : null } });
  if (message.method !== "thread/read" || message.params.includeTurns !== false) return send({ id: message.id, error: { message: "Unexpected operation" } });
  send({ id: message.id, result: { thread: { id: options.wrongIdentity ? "another-thread" : message.params.threadId, path: process.env.CODEX_HOME + "/sessions/rollout-current.jsonl", turns: options.hydrated ? [{ id: "unexpected-turn" }] : [] } } });
});
`
  );
  const reader = createCodexHistoryMetadataReader({
    binary,
    codexHome: home,
    env: { ...process.env, CODEX_HOME: "/unused/status-check-home" },
    requestTimeoutMs: 1000,
    ...(options.idleMs ? { idleMs: options.idleMs } : {})
  });
  return {
    root,
    home,
    binary,
    reader,
    requests: () =>
      readFileSync(log, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string })
  };
};

describe("native history metadata connection", () => {
  it("uses the configured home and reuses one metadata-only connection", async () => {
    const f = fixture();
    try {
      expect((await f.reader.readThread("thread-1")).path).toBe(
        path.join(f.home, "sessions/rollout-current.jsonl")
      );
      await f.reader.readThread("thread-2");
      expect(f.requests().map((value) => value.method)).toEqual([
        "initialize",
        "initialized",
        "thread/read",
        "thread/turns/list",
        "thread/read",
        "thread/turns/list"
      ]);
    } finally {
      await f.reader.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it.each([
    { options: { wrongHome: true }, error: "codex_history_home_mismatch" },
    {
      options: { wrongIdentity: true },
      error: "codex_history_identity_mismatch"
    },
    {
      options: { hydrated: true },
      error: "codex_history_unexpected_hydration"
    },
    {
      options: { invalidPage: "missing-id" as const },
      error: "codex_history_page_invalid"
    },
    {
      options: { invalidPage: "empty-cursor" as const },
      error: "codex_history_page_invalid"
    },
    {
      options: { invalidPage: "oversized" as const },
      error: "codex_history_page_invalid"
    }
  ])(
    "rejects incorrect native metadata with $error",
    async ({ options, error }) => {
      const f = fixture(options);
      try {
        await expect(f.reader.readThread("thread-1")).rejects.toThrow(error);
      } finally {
        await f.reader.close();
        rmSync(f.root, { recursive: true, force: true });
      }
    }
  );
  it("reconnects after an owned helper becomes idle and rejects reads after close", async () => {
    const f = fixture({ idleMs: 10 });
    try {
      await f.reader.readThread("thread-1");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await f.reader.readThread("thread-2");
      expect(
        f.requests().filter((value) => value.method === "initialize")
      ).toHaveLength(2);
      await f.reader.close();
      await expect(f.reader.readThread("thread-3")).rejects.toThrow(
        "codex_history_metadata_closed"
      );
    } finally {
      await f.reader.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("reuses a borrowed initialized client without closing its owner's connection", async () => {
    const f = fixture();
    const client = new CodexAppServerClient(
      f.binary,
      f.home,
      { ...process.env, CODEX_HOME: f.home },
      undefined,
      {
        configOverrides: [
          "features.background_paginated_rollout_migration=false"
        ]
      }
    );
    const reader = createCodexHistoryMetadataReader({
      binary: f.binary,
      codexHome: f.home,
      env: {},
      client
    });
    try {
      await client.initialize("fixture-owner");
      await Promise.all([
        reader.readThread("thread-1"),
        reader.readThread("thread-2")
      ]);
      await reader.close();
      expect(client.isClosed()).toBe(false);
      await expect(client.readThread("thread-3")).resolves.toMatchObject({
        id: "thread-3"
      });
      expect(
        f.requests().filter((value) => value.method === "initialize")
      ).toHaveLength(1);
    } finally {
      await reader.close();
      await client.closeAndWait();
      await f.reader.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

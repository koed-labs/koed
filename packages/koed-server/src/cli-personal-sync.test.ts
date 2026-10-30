import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runKoedServerCli } from "./cli.js";

const output = () => {
  let text = "";
  return {
    stream: {
      write: (chunk: unknown) => {
        text += String(chunk);
        return true;
      }
    },
    text: () => text
  };
};

const pairFixture = () => {
  const scratchRoot = resolve(import.meta.dirname, "../../../scratch");
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(resolve(scratchRoot, "cli-pair-flow-"));
  const credential = resolve(root, "credential");
  writeFileSync(credential, "fixture");
  const paths = { localAppCredentialPath: credential } as never;
  const stdout = output();
  return {
    root,
    paths,
    stdout,
    dependencies: {
      stdout: stdout.stream,
      resolvePaths: () => paths,
      collectStartupStatus: async () => ({ ok: true }) as never
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
};

const recoveryInvocations = [
  [
    "group",
    "bootstrap",
    "--recovery-kit",
    "/protected/kit",
    "--runtime-secret-ref",
    "runtime",
    "--password-fd",
    "7"
  ],
  ["invite", "create", "--group-id", "group"],
  ["join", "request", "--group-id", "group", "--invitation-fd", "7"],
  ["join", "redeem", "--link-fd", "7", "--device-label", "Laptop"],
  ["join", "complete", "--group-id", "group", "--challenge-id", "challenge"],
  [
    "join",
    "bind-local-user",
    "--group-id",
    "group",
    "--user-id",
    "user",
    "--challenge-id",
    "challenge"
  ],
  ["join", "challenge"],
  ["active-device", "approve", "--request-fd", "7"],
  ["active-device", "refresh"],
  ["device", "list", "--group-id", "group"],
  [
    "device",
    "revoke",
    "--group-id",
    "group",
    "--statement-fd",
    "7",
    "--key-bundle-fd",
    "8",
    "--proof-fd",
    "9"
  ],
  ["policy", "enable", "--group-id", "group"],
  ["policy", "pause", "--group-id", "group"],
  ["policy", "resume", "--group-id", "group"],
  ["replica", "status", "--group-id", "group"],
  ["retry", "--group-id", "group"],
  ["recovery", "approve", "--group-id", "group", "--statement-fd", "7"],
  ["recovery", "guidance"],
  [
    "recovery-kit",
    "create",
    "--output",
    "/protected/kit",
    "--payload-fd",
    "7",
    "--password-stdin"
  ],
  [
    "recovery-kit",
    "verify",
    "--recovery-kit",
    "/protected/kit",
    "--password-fd",
    "7"
  ]
];

describe("Personal Sync CLI contracts", () => {
  it.each(recoveryInvocations.map((args) => [args]))(
    "dispatches protected recovery inputs for %j",
    async (args) => {
      const stdout = output();
      const paths = {} as never;
      const runPersonalSync = vi.fn(
        async () => ({ ok: true, state: "complete", message: "done" }) as never
      );
      expect(
        await runKoedServerCli(["personal-sync", ...args, "--json"], {
          stdout: stdout.stream,
          resolvePaths: () => paths,
          runPersonalSync
        })
      ).toBe(0);
      expect(runPersonalSync).toHaveBeenCalledExactlyOnceWith(
        args,
        paths,
        process.env
      );
      expect(JSON.parse(stdout.text())).toMatchObject({
        ok: true,
        message: "done"
      });
    }
  );

  it("shows recovery commands only in the advanced view", async () => {
    const normal = output();
    const advanced = output();
    await runKoedServerCli(["personal-sync", "--help"], {
      stdout: normal.stream
    });
    await runKoedServerCli(["personal-sync", "--help", "--advanced"], {
      stdout: advanced.stream
    });
    expect(normal.text()).not.toContain("recovery-kit");
    expect(advanced.text()).toContain("recovery-kit");
  });

  it.each(["--password=private-value", "--link=private-value"])(
    "rejects unsafe recovery input %s before any operation",
    async (argument) => {
      const stdout = output();
      const stderr = output();
      const runPersonalSync = vi.fn(async () => {
        throw new Error("unsafe input reached recovery");
      });
      expect(
        await runKoedServerCli(
          ["personal-sync", "join", "redeem", argument, "--json"],
          { stdout: stdout.stream, stderr: stderr.stream, runPersonalSync }
        )
      ).toBe(2);
      expect(runPersonalSync).not.toHaveBeenCalled();
      expect(stdout.text() + stderr.text()).not.toContain("private-value");
    }
  );

  it("keeps bare pairing as enrollment and returns initial progress in detached mode", async () => {
    const scratchRoot = resolve(import.meta.dirname, "../../../scratch");
    mkdirSync(scratchRoot, { recursive: true });
    const root = mkdtempSync(resolve(scratchRoot, "cli-pair-"));
    try {
      const credential = resolve(root, "credential");
      writeFileSync(credential, "fixture");
      const stdout = output();
      const deviceRequest = vi.fn(
        async () =>
          ({
            state: "waiting",
            link: "test-link",
            expiresAt: "2026-10-30T12:00:00Z"
          }) as never
      );
      const startDaemon = vi.fn(() => {
        throw new Error("healthy installation restarted");
      });
      expect(
        await runKoedServerCli(
          ["pair", "--device-label", "Laptop", "--detach", "--json"],
          {
            stdout: stdout.stream,
            resolvePaths: () =>
              ({ localAppCredentialPath: credential }) as never,
            collectStartupStatus: async () => ({ ok: true }) as never,
            deviceRequest,
            startDaemon
          }
        )
      ).toBe(0);
      expect(deviceRequest).toHaveBeenCalledWith(
        expect.anything(),
        "create",
        "Laptop"
      );
      expect(startDaemon).not.toHaveBeenCalled();
      expect(JSON.parse(stdout.text())).toMatchObject({
        state: "waiting",
        link: "test-link"
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(["status", "cancel"] as const)(
    "keeps pairing %s separate from enrollment startup",
    async (operation) => {
      const fixture = pairFixture();
      try {
        const deviceRequest = vi.fn(
          async () =>
            ({
              state: operation === "cancel" ? "cancelled" : "waiting"
            }) as never
        );
        const collectStartupStatus = vi.fn(async () => {
          throw new Error("status/cancel started enrollment");
        });
        expect(
          await runKoedServerCli(["pair", operation, "--json"], {
            ...fixture.dependencies,
            deviceRequest,
            collectStartupStatus
          })
        ).toBe(0);
        expect(deviceRequest).toHaveBeenCalledExactlyOnceWith(
          fixture.paths,
          operation
        );
        expect(collectStartupStatus).not.toHaveBeenCalled();
      } finally {
        fixture.cleanup();
      }
    }
  );

  it("reports readiness failure without creating an enrollment request", async () => {
    const fixture = pairFixture();
    try {
      const deviceRequest = vi.fn(async () => {
        throw new Error("unready installation created a request");
      });
      const startDaemon = vi.fn(
        () =>
          ({
            ok: false,
            error: "startup rejected",
            message: "startup rejected"
          }) as never
      );
      expect(
        await runKoedServerCli(["pair", "--json"], {
          ...fixture.dependencies,
          deviceRequest,
          startDaemon,
          collectStartupStatus: async () => ({ ok: false }) as never
        })
      ).toBe(1);
      expect(deviceRequest).not.toHaveBeenCalled();
      expect(JSON.parse(fixture.stdout.text())).toMatchObject({
        ok: false,
        error: "startup rejected"
      });
    } finally {
      fixture.cleanup();
    }
  });

  it.each([false, true])(
    "keeps bare pairing and progress output until connection (json=%s)",
    async (json) => {
      const fixture = pairFixture();
      const deviceRequest = vi
        .fn()
        .mockResolvedValueOnce({
          state: "waiting",
          link: "test-link",
          expiresAt: "2026-10-30T12:00:00Z"
        })
        .mockResolvedValueOnce({ state: "waiting" })
        .mockResolvedValueOnce({ state: "approved" })
        .mockResolvedValueOnce({ state: "connected" });
      vi.useFakeTimers();
      try {
        const result = runKoedServerCli(["pair", ...(json ? ["--json"] : [])], {
          ...fixture.dependencies,
          deviceRequest
        });
        await vi.waitFor(() => expect(deviceRequest).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(3000);
        expect(await result).toBe(0);
        const states = [
          ...fixture.stdout.text().matchAll(/"state": "([^"]+)"/g)
        ].map((match) => match[1]);
        if (json) expect(states).toEqual(["waiting", "approved", "connected"]);
        else {
          expect(fixture.stdout.text()).toContain("test-link");
          expect(fixture.stdout.text()).toContain("approved\nconnected\n");
          expect(fixture.stdout.text()).not.toContain("\nwaiting\n");
        }
        expect(deviceRequest).toHaveBeenCalledTimes(4);
      } finally {
        vi.useRealTimers();
        fixture.cleanup();
      }
    }
  );
  it("retains Desktop revocation metadata without bypassing signed transition inputs", async () => {
    const stdout = output();
    expect(
      await runKoedServerCli(
        [
          "personal-sync",
          "device",
          "revoke",
          "--group-id",
          "group",
          "--device-id",
          "device",
          "--json"
        ],
        {
          stdout: stdout.stream,
          resolvePaths: () => ({}) as never
        }
      )
    ).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({
      error: "--statement-fd is required."
    });
  });
});

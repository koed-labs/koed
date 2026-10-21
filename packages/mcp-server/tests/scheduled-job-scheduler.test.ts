import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  readDesktopLocalCredentialAuthorization,
  storeDesktopLocalCredential
} from "@koed/shared";
import * as shared from "@koed/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startScheduledJobScheduler } from "../src/scheduled-job-scheduler.js";

const homes: string[] = [];
const homeWithCredential = (
  operationFamilies: Parameters<
    typeof storeDesktopLocalCredential
  >[1]["operationFamilies"]
) => {
  const home = mkdtempSync(join(tmpdir(), "koed-scheduled-tick-"));
  homes.push(home);
  storeDesktopLocalCredential(home, {
    ownerUserId: randomUUID(),
    operationFamilies
  });
  return home;
};
const accepted = () =>
  new Response(
    JSON.stringify({
      materialized: 0,
      dispatched: 0,
      needsReview: 0,
      reconciled: 0
    }),
    { status: 200 }
  );

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("Scheduled Job scheduler local transport", () => {
  it("sends only an empty tick to local HTTP with the sealed Desktop credential", async () => {
    const home = homeWithCredential([
      "managed_execution",
      "personal_collaboration_write"
    ]);
    const credential = readDesktopLocalCredentialAuthorization(home);
    const send = vi.fn<typeof fetch>(async () => accepted());
    const scheduler = startScheduledJobScheduler({
      apiUrl: "http://127.0.0.1:32123/",
      koedHome: home,
      fetch: send,
      intervalMs: 60_000
    });
    try {
      await scheduler.tick();
      expect(send).toHaveBeenCalledTimes(1);
      const [url, request] = send.mock.calls[0]!;
      expect(String(url)).toBe(
        "http://127.0.0.1:32123/v1/scheduled-jobs/runtime/tick"
      );
      expect(request).toMatchObject({
        method: "POST",
        redirect: "error",
        body: "{}",
        headers: {
          authorization: credential?.authorization,
          accept: "application/json",
          "content-type": "application/json"
        }
      });
      expect(request?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      scheduler.stop();
    }
  });

  it.each([
    { label: "managed execution", families: ["managed_execution"] as const },
    {
      label: "Personal write",
      families: ["personal_collaboration_write"] as const
    }
  ])(
    "does not send when $label is the only credential family",
    async ({ families }) => {
      const home = homeWithCredential([
        "managed_execution",
        "personal_collaboration_write"
      ]);
      const stored = readDesktopLocalCredentialAuthorization(home)!;
      vi.spyOn(
        shared,
        "readDesktopLocalCredentialAuthorization"
      ).mockReturnValue({
        ...stored,
        operationFamilies: [...families]
      });
      const send = vi.fn<typeof fetch>(async () => accepted());
      const scheduler = startScheduledJobScheduler({
        apiUrl: "http://localhost:32123",
        koedHome: home,
        fetch: send
      });
      await scheduler.tick();
      scheduler.stop();
      expect(send).not.toHaveBeenCalled();
    }
  );

  it("does not send when no Desktop credential exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-scheduled-tick-"));
    homes.push(home);
    const send = vi.fn<typeof fetch>(async () => accepted());
    const scheduler = startScheduledJobScheduler({
      apiUrl: "http://localhost:32123",
      koedHome: home,
      fetch: send
    });
    await scheduler.tick();
    scheduler.stop();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses remote or URL-credential origins before a tick can send", () => {
    const home = homeWithCredential([
      "managed_execution",
      "personal_collaboration_write"
    ]);
    const send = vi.fn<typeof fetch>(async () => accepted());
    for (const apiUrl of [
      "https://team.example.test",
      "http://team.example.test",
      "http://user:secret@localhost:32123"
    ]) {
      expect(() =>
        startScheduledJobScheduler({ apiUrl, koedHome: home, fetch: send })
      ).toThrow("local Personal API");
    }
    expect(send).not.toHaveBeenCalled();
  });

  it.each([302, 503])("does not follow or suppress HTTP %s", async (status) => {
    const home = homeWithCredential([
      "managed_execution",
      "personal_collaboration_write"
    ]);
    const onError = vi.fn();
    const send = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status,
          headers: { location: "https://team.example.test/collect" }
        })
    );
    const scheduler = startScheduledJobScheduler({
      apiUrl: "http://localhost:32123",
      koedHome: home,
      fetch: send,
      onError
    });
    try {
      await expect(scheduler.tick()).rejects.toThrow(
        `Scheduled Job tick unavailable (${status})`
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[1]?.redirect).toBe("error");
    } finally {
      scheduler.stop();
    }
  });

  it("coalesces overlapping HTTP ticks and stop prevents another interval or manual tick", async () => {
    vi.useFakeTimers();
    const home = homeWithCredential([
      "managed_execution",
      "personal_collaboration_write"
    ]);
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const send = vi.fn<typeof fetch>(async () => pending);
    const scheduler = startScheduledJobScheduler({
      apiUrl: "http://localhost:32123",
      koedHome: home,
      fetch: send,
      intervalMs: 1000
    });
    const sameTick = scheduler.tick();
    await vi.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenCalledTimes(1);
    release(accepted());
    await sameTick;
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(3000);
    await scheduler.tick();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

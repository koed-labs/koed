import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPullRequestInboxScheduler,
  PULL_REQUEST_INBOX_REFRESH_INTERVAL_MS,
  pullRequestInboxAutomaticRequestId
} from "./pull-request-inbox-scheduler.js";

const account = { id: "42", login: "Alice" };
const target = { targetDeviceId: "device-a", targetDeploymentId: "deploy-a" };

afterEach(() => {
  vi.useRealTimers();
});

describe("pull request inbox scheduler", () => {
  it("derives one bounded request id per account, connection, device, and five-minute cycle", () => {
    const input = {
      account,
      connectionGeneration: 3,
      ...target,
      now: 600_001
    };
    const requestId = pullRequestInboxAutomaticRequestId(input);
    expect(requestId).toBe(pullRequestInboxAutomaticRequestId(input));
    expect(requestId).toMatch(/^pr-inbox:auto:2:[a-f0-9]{64}$/);
    expect(requestId.length).toBeLessThanOrEqual(240);
    expect(
      pullRequestInboxAutomaticRequestId({ ...input, now: 900_000 })
    ).not.toBe(requestId);
    expect(
      pullRequestInboxAutomaticRequestId({
        ...input,
        connectionGeneration: 4
      })
    ).not.toBe(requestId);
    expect(
      pullRequestInboxAutomaticRequestId({
        ...input,
        targetDeviceId: "device-b"
      })
    ).not.toBe(requestId);
    expect(
      pullRequestInboxAutomaticRequestId({
        ...input,
        account: { id: "84", login: "Bob" }
      })
    ).not.toBe(requestId);
  });

  it("coalesces startup, reconnect, and periodic triggers into the durable cycle operation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(300_100);
    const requestRefresh = vi.fn(
      async ({ requestId }: { requestId: string }) => ({
        id: requestId
      })
    );
    const scheduler = createPullRequestInboxScheduler({
      account: async () => ({ account, connectionGeneration: 1 }),
      requestRefresh,
      ...target
    });

    scheduler.start();
    await vi.waitFor(() => expect(requestRefresh).toHaveBeenCalledOnce());
    await scheduler.trigger("reconnect");
    expect(requestRefresh).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(PULL_REQUEST_INBOX_REFRESH_INTERVAL_MS);
    expect(requestRefresh).toHaveBeenCalledTimes(2);
    expect(requestRefresh.mock.calls[0]?.[0].requestId).not.toBe(
      requestRefresh.mock.calls[1]?.[0].requestId
    );
    scheduler.stop();
  });

  it("waits while disconnected and immediately schedules the newly selected generation", async () => {
    const requestRefresh = vi.fn(
      async ({ requestId }: { requestId: string }) => ({
        id: requestId
      })
    );
    let selected: {
      account: typeof account | null;
      connectionGeneration: number;
    } = {
      account: null,
      connectionGeneration: 1
    };
    const scheduler = createPullRequestInboxScheduler({
      account: async () => selected,
      requestRefresh,
      ...target,
      now: () => 300_000
    });

    expect(await scheduler.trigger("startup")).toBeNull();
    expect(requestRefresh).not.toHaveBeenCalled();

    selected = { account, connectionGeneration: 2 };
    await scheduler.trigger("reconnect");
    expect(requestRefresh).toHaveBeenCalledOnce();
    expect(requestRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        connectionGeneration: 2
      })
    );
    scheduler.stop();
  });

  it("retries operation registration after an offline failure in the same cycle", async () => {
    const requestRefresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ id: "registered" });
    const onError = vi.fn();
    const scheduler = createPullRequestInboxScheduler({
      account: async () => ({ account, connectionGeneration: 1 }),
      requestRefresh,
      ...target,
      now: () => 300_000,
      onError
    });

    await expect(scheduler.trigger("startup")).rejects.toThrow("offline");
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "startup");
    await expect(scheduler.trigger("reconnect")).resolves.toEqual({
      id: "registered"
    });
    expect(requestRefresh).toHaveBeenCalledTimes(2);
    expect(requestRefresh.mock.calls[0]?.[0].requestId).toBe(
      requestRefresh.mock.calls[1]?.[0].requestId
    );
    scheduler.stop();
  });
});

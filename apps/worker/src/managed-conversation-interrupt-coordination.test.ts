import { describe, expect, it, vi } from "vitest";

import {
  coordinateManagedConversationInterrupt,
  createManagedConversationPromptInterruptLatch,
  waitForManagedConversationPromptDispatch
} from "./managed-conversation-service.js";

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

describe("managed Conversation interrupt coordination", () => {
  it("waits for an in-progress claim to publish the prompt dispatch id", async () => {
    let activeCommandId: string | undefined;
    const result = await waitForManagedConversationPromptDispatch({
      activeCommandId: () => activeCommandId,
      claimInProgress: () => true,
      wait: async () => {
        activeCommandId = "prompt-command-1";
      },
      maxAttempts: 2
    });

    expect(result).toEqual({
      status: "found",
      commandId: "prompt-command-1"
    });
  });

  it("reports no dispatch when no claim is in progress", async () => {
    const wait = vi.fn(async () => undefined);
    const result = await waitForManagedConversationPromptDispatch({
      activeCommandId: () => undefined,
      claimInProgress: () => false,
      wait
    });

    expect(result).toEqual({ status: "none" });
    expect(wait).not.toHaveBeenCalled();
  });

  it("keeps an unresolved claim pending when the bounded wait expires", async () => {
    const result = await waitForManagedConversationPromptDispatch({
      activeCommandId: () => undefined,
      claimInProgress: () => true,
      wait: async () => undefined,
      maxAttempts: 2
    });

    expect(result).toEqual({ status: "pending" });
  });

  it("consumes a Stop latch after async preparation without affecting another command", async () => {
    const latch = createManagedConversationPromptInterruptLatch();
    const prepareFirstCommand = deferred();
    const firstReadyToSubmit = deferred();
    const providerSubmit = vi.fn(async (commandId: string) => commandId);
    const submitAfterPreparation = async (
      commandId: string,
      preparation: Promise<void>,
      ready?: ReturnType<typeof deferred>
    ) => {
      await preparation;
      ready?.resolve();
      if (latch.consumeBeforeProviderSubmission(commandId)) return "stopped";
      await providerSubmit(commandId);
      return "submitted";
    };

    const firstSubmission = submitAfterPreparation(
      "prompt-command-1",
      prepareFirstCommand.promise,
      firstReadyToSubmit
    );
    latch.request("prompt-command-1");
    expect(latch.hasRequest("prompt-command-1")).toBe(true);
    prepareFirstCommand.resolve();
    await firstReadyToSubmit.promise;
    await expect(firstSubmission).resolves.toBe("stopped");
    expect(providerSubmit).not.toHaveBeenCalled();
    expect(latch.hasRequest("prompt-command-1")).toBe(false);

    await expect(
      submitAfterPreparation("prompt-command-2", Promise.resolve())
    ).resolves.toBe("submitted");
    expect(providerSubmit).toHaveBeenCalledOnce();
    expect(providerSubmit).toHaveBeenCalledWith("prompt-command-2");
  });

  it("retries a nonterminal Codex interrupt until the provider confirms interruption", async () => {
    const firstRetryWait = deferred();
    const releaseRetry = deferred();
    let active = true;
    let interruptAttempts = 0;
    const interruption = coordinateManagedConversationInterrupt({
      dispatchActive: () => active,
      interrupt: async () => {
        interruptAttempts += 1;
        return interruptAttempts === 2;
      },
      wait: async () => {
        firstRetryWait.resolve();
        await releaseRetry.promise;
      },
      maxAttempts: 3
    });
    let outcome: string | undefined;
    void interruption.then((value) => {
      outcome = value;
    });

    await firstRetryWait.promise;
    expect(interruptAttempts).toBe(1);
    expect(outcome).toBeUndefined();
    releaseRetry.resolve();
    await expect(interruption).resolves.toBe("interrupted");
    expect(interruptAttempts).toBe(2);
    active = false;
  });

  it("returns deferred after bounded nonterminal interrupts and finished after dispatch ends", async () => {
    const interrupt = vi.fn(async () => false);
    await expect(
      coordinateManagedConversationInterrupt({
        dispatchActive: () => true,
        interrupt,
        wait: async () => undefined,
        maxAttempts: 2
      })
    ).resolves.toBe("deferred");
    expect(interrupt).toHaveBeenCalledTimes(2);

    const completedDispatchInterrupt = vi.fn(async () => true);
    await expect(
      coordinateManagedConversationInterrupt({
        dispatchActive: () => false,
        interrupt: completedDispatchInterrupt,
        wait: async () => undefined,
        maxAttempts: 2
      })
    ).resolves.toBe("finished");
    expect(completedDispatchInterrupt).not.toHaveBeenCalled();
  });

  it("returns finished if dispatch ends between provider interrupt attempts", async () => {
    const retryWait = deferred();
    const releaseRetry = deferred();
    let active = true;
    const interrupt = vi.fn(async () => false);
    const coordination = coordinateManagedConversationInterrupt({
      dispatchActive: () => active,
      interrupt,
      wait: async () => {
        retryWait.resolve();
        await releaseRetry.promise;
      },
      maxAttempts: 3
    });

    await retryWait.promise;
    active = false;
    releaseRetry.resolve();

    await expect(coordination).resolves.toBe("finished");
    expect(interrupt).toHaveBeenCalledOnce();
  });
});

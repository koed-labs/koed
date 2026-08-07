import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";

import {
  koedLocalWorkSignalPath,
  requestKoedLocalWork,
  watchKoedLocalWork
} from "./local-work-signal.js";

const handles: Array<{ stop(): void }> = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop();
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for signal");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("Koed local work signals", () => {
  it("coalesces requests and wakes the watcher without polling", async () => {
    const koedHome = await mkdtemp(path.join(os.tmpdir(), "koed-signal-"));
    const onSignal = vi.fn();
    await Promise.all([
      requestKoedLocalWork(koedHome, "lcm-summary"),
      requestKoedLocalWork(koedHome, "lcm-summary")
    ]);
    const handle = await watchKoedLocalWork(koedHome, "lcm-summary", onSignal);
    handles.push(handle);
    await waitFor(() => onSignal.mock.calls.length === 1);

    await requestKoedLocalWork(koedHome, "lcm-summary");
    await waitFor(() => onSignal.mock.calls.length === 2);
  });

  it("recovers a claimed signal left behind by a crashed process", async () => {
    const koedHome = await mkdtemp(path.join(os.tmpdir(), "koed-signal-"));
    const pending = koedLocalWorkSignalPath(koedHome, "lcm-summary");
    await mkdir(path.dirname(pending), { recursive: true });
    await writeFile(`${pending}.processing.123.456`, "{}", "utf8");
    const onSignal = vi.fn();
    const handle = await watchKoedLocalWork(koedHome, "lcm-summary", onSignal);
    handles.push(handle);
    await waitFor(() => onSignal.mock.calls.length === 1);
  });

  it("fails closed when the pending marker is a symlink", async () => {
    const koedHome = await mkdtemp(path.join(os.tmpdir(), "koed-signal-"));
    const pending = koedLocalWorkSignalPath(koedHome, "lcm-summary");
    await mkdir(path.dirname(pending), { recursive: true });
    const target = path.join(koedHome, "signal-target");
    await writeFile(target, "{}", "utf8");
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(target, pending)
    );
    const onError = vi.fn();
    const handle = await watchKoedLocalWork(
      koedHome,
      "lcm-summary",
      vi.fn(),
      onError
    );
    handles.push(handle);
    await waitFor(() => onError.mock.calls.length >= 1);
  });
});

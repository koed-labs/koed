import { describe, expect, it, vi } from "vitest";

import { createHistoricalSourceInOpenRun } from "../src/automatic-historical-provider.js";
import { MemoryApiError, type MemoryApiClient } from "../src/index.js";

const conflict = (code: string) =>
  new MemoryApiError("conflict", { status: 409, payload: { code } });

const fakeClient = (
  createSource: (input: Record<string, unknown>) => unknown
) =>
  ({
    createHistoricalImportRun: vi.fn(async () => ({ run: { id: "run-new" } })),
    transitionHistoricalImportRun: vi.fn(async () => ({})),
    createHistoricalImportSource: vi.fn(
      async (input: Record<string, unknown>) => createSource(input)
    )
  }) as unknown as MemoryApiClient;

describe("createHistoricalSourceInOpenRun", () => {
  it("starts a new run when the saved run was closed", async () => {
    const client = fakeClient((input) => {
      if (input.runId === "run-closed")
        throw conflict("historical_import_run_not_found");
      return { source: { id: "source", runId: input.runId } };
    });
    const created = await createHistoricalSourceInOpenRun(
      client,
      "run-closed",
      {
        artifactId: "artifact"
      }
    );
    expect(created.runId).toBe("run-new");
    expect(client.createHistoricalImportSource).toHaveBeenLastCalledWith({
      artifactId: "artifact",
      runId: "run-new"
    });
  });

  it("does not start a run for an artifact problem", async () => {
    const client = fakeClient(() => {
      throw conflict("historical_import_artifact_unavailable");
    });
    await expect(
      createHistoricalSourceInOpenRun(client, "run-open", { artifactId: "a" })
    ).rejects.toThrow("conflict");
    expect(client.createHistoricalImportRun).not.toHaveBeenCalled();
  });
});

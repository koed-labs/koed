import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  managedDevelopmentPreviewAccessSchema,
  managedDevelopmentPreviewCandidateSchema,
  managedDevelopmentPreviewRecordSchema
} from "./managed-development-preview.js";

describe("managed development preview contracts", () => {
  const executionId = randomUUID();
  const terminalId = randomUUID();

  it("keeps public lifecycle records free of navigation authority", () => {
    const record = managedDevelopmentPreviewRecordSchema.parse({
      id: randomUUID(),
      executionId,
      executionGeneration: 2,
      terminalId,
      lifecycleGeneration: 3,
      state: "available",
      source: "terminal_output",
      policyVersion: 1,
      discoveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    expect(JSON.stringify(record)).not.toMatch(/url|port|pid|path/i);
    expect(() =>
      managedDevelopmentPreviewRecordSchema.parse({
        ...record,
        navigationUrl: "http://127.0.0.1:5173/"
      })
    ).toThrow();
  });

  it("bounds nominations and isolates the main-process access contract", () => {
    expect(
      managedDevelopmentPreviewCandidateSchema.parse({
        executionGeneration: 2,
        terminalId,
        scheme: "http",
        port: 5_173
      })
    ).toMatchObject({ port: 5_173 });
    expect(() =>
      managedDevelopmentPreviewCandidateSchema.parse({
        executionGeneration: 2,
        terminalId,
        scheme: "file",
        port: 0
      })
    ).toThrow();

    expect(
      managedDevelopmentPreviewAccessSchema.parse({
        preview: {
          id: randomUUID(),
          executionId,
          executionGeneration: 2,
          terminalId,
          lifecycleGeneration: 3,
          state: "available",
          source: "user_port",
          policyVersion: 1,
          discoveredAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        navigationUrl: "http://127.0.0.1:5173/"
      }).navigationUrl
    ).toBe("http://127.0.0.1:5173/");
  });
});

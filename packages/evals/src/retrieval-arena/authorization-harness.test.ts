import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REQUIRED_AUTHORIZATION_BOUNDARIES,
  authorizationManifestSchema,
  runProductAuthorizationHarness
} from "./authorization-harness.js";

describe("Retrieval Arena product authorization harness", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires every authorization boundary and validates the fixture manifest", async () => {
    expect(() =>
      authorizationManifestSchema.parse({
        schemaVersion: "koed-retrieval-authorization-v1",
        probes: [
          {
            id: "only-one",
            boundary: "revoked",
            authorizationEnv: "AUTH",
            query: "query"
          }
        ]
      })
    ).toThrow(/missing required cross_user probe/);
    const fixture = JSON.parse(
      await readFile(
        new URL(
          "../../fixtures/retrieval-arena-authorization.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as unknown;
    const parsed = authorizationManifestSchema.parse(fixture);
    expect(new Set(parsed.probes.map((probe) => probe.boundary))).toEqual(
      new Set(REQUIRED_AUTHORIZATION_BOUNDARIES)
    );
  });

  it("executes real boundary probes without reporting credentials or bodies", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "koed-arena-auth-"));
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: "koed-retrieval-authorization-v1",
        baseUrl: "http://127.0.0.1:3000",
        probes: REQUIRED_AUTHORIZATION_BOUNDARIES.map((boundary) => ({
          id: boundary,
          boundary,
          authorizationEnv: "FIXTURE_AUTHORIZATION",
          query: `${boundary} marker`,
          expectedHttpStatus: boundary === "api_token_team_denial" ? 403 : 200,
          ...(boundary === "revoked"
            ? {
                mustContain: ["authorized marker"],
                mustNotContain: ["revoked marker"]
              }
            : {})
        }))
      })
    );
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        return body.query === "api_token_team_denial marker"
          ? new Response("denied", { status: 403 })
          : new Response("authorized marker", { status: 200 });
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const report = await runProductAuthorizationHarness({
        manifestPath,
        env: {
          FIXTURE_AUTHORIZATION: "Bearer fixture-secret"
        }
      });
      expect(report.probes.filter((probe) => !probe.passed)).toEqual([]);
      expect(report.probes).toHaveLength(
        REQUIRED_AUTHORIZATION_BOUNDARIES.length
      );
      expect(report.probes.every((probe) => probe.passed)).toBe(true);
      expect(JSON.stringify(report)).not.toContain("fixture-secret");
      expect(JSON.stringify(report)).not.toContain("authorized marker");
      expect(fetchMock).toHaveBeenCalledTimes(
        REQUIRED_AUTHORIZATION_BOUNDARIES.length
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not satisfy sentinel checks from an echoed query", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "koed-arena-auth-"));
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: "koed-retrieval-authorization-v1",
        baseUrl: "http://127.0.0.1:3000",
        probes: REQUIRED_AUTHORIZATION_BOUNDARIES.map((boundary) => ({
          id: boundary,
          boundary,
          authorizationEnv: "AUTH",
          query: "revoked sentinel",
          ...(boundary === "revoked"
            ? { mustNotContain: ["revoked sentinel"] }
            : {})
        }))
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              evidenceBundle: { query: "revoked sentinel", evidence: [] },
              markdown: "No authorized evidence."
            }),
            { status: 200 }
          )
        )
      )
    );
    try {
      const report = await runProductAuthorizationHarness({
        manifestPath,
        env: { AUTH: "Bearer fixture" }
      });
      expect(report.probes.filter((probe) => !probe.passed)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

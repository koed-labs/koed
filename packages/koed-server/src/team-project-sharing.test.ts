import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KoedServerPaths } from "./paths.js";
import { linkProjectTeamWorkspace } from "./project-team-workspace-links.js";
import { shareProjectCapturedSession } from "./team-project-sharing.js";

const pathsFor = (directory: string): KoedServerPaths =>
  ({
    koedHome: directory,
    runDir: path.join(directory, "run"),
    configDir: path.join(directory, "config"),
    explorerTokenPath: path.join(directory, "config", "explorer-token.json"),
    projectTeamWorkspaceLinksPath: path.join(
      directory,
      "config",
      "project-team-workspaces.json"
    )
  }) as KoedServerPaths;

describe("Team Project sharing", () => {
  it("fails closed without a Team session cookie", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-share-"));
    const paths = pathsFor(directory);
    linkProjectTeamWorkspace(paths, {
      projectRoot: "/repo/koed",
      teamWorkspaceId: "11111111-1111-4111-8111-111111111111"
    });

    const result = await shareProjectCapturedSession(
      paths,
      {
        projectRoot: "/repo/koed",
        sessionId: "22222222-2222-4222-8222-222222222222"
      },
      { MEMORY_API_TOKEN: "cmt_test" } as NodeJS.ProcessEnv,
      {}
    );

    expect(result).toMatchObject({
      ok: false,
      state: "needs_attention"
    });
    expect(result.message).toContain("API Tokens cannot manage Team sharing");
  });

  it("uses API Token only for latest lookup and session cookie for Share Grant creation", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-share-"));
    const paths = pathsFor(directory);
    const teamWorkspaceId = "11111111-1111-4111-8111-111111111111";
    const sessionId = "22222222-2222-4222-8222-222222222222";
    linkProjectTeamWorkspace(paths, {
      projectRoot: "/repo/koed",
      teamWorkspaceId
    });
    const calls: Array<{
      url: string;
      authorization?: string;
      cookie?: string;
      body?: string;
    }> = [];

    const result = await shareProjectCapturedSession(
      paths,
      { projectRoot: "/repo/koed" },
      {
        MEMORY_API_URL: "http://koed.test",
        MEMORY_API_TOKEN: "cmt_lookup",
        KOED_TEAM_SESSION_COOKIE: "cms_share"
      } as NodeJS.ProcessEnv,
      {},
      {
        fetch: async (url, init) => {
          calls.push({
            url: String(url),
            authorization:
              new Headers(init?.headers).get("authorization") ?? undefined,
            cookie: new Headers(init?.headers).get("cookie") ?? undefined,
            body: typeof init?.body === "string" ? init.body : undefined
          });
          if (String(url).includes("/v1/sessions/latest")) {
            return Response.json({ session: { id: sessionId } });
          }
          if (String(url).includes(`/v1/sessions/${sessionId}`)) {
            return Response.json({
              session: { id: sessionId, workspaceId: "/repo/koed" }
            });
          }
          return Response.json({ shareGrant: { id: "grant-1", sessionId } });
        }
      }
    );

    expect(result).toMatchObject({
      ok: true,
      state: "shared",
      sessionId,
      teamWorkspaceId
    });
    expect(calls[0]).toMatchObject({
      authorization: "Bearer cmt_lookup",
      cookie: undefined
    });
    expect(calls[1]).toMatchObject({
      authorization: "Bearer cmt_lookup",
      cookie: undefined
    });
    expect(calls[2]).toMatchObject({
      authorization: undefined,
      cookie: "cm_session=cms_share",
      body: JSON.stringify({ sessionId })
    });
  });

  it("verifies selected sessions before creating Share Grants", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-share-"));
    const paths = pathsFor(directory);
    const teamWorkspaceId = "11111111-1111-4111-8111-111111111111";
    const sessionId = "22222222-2222-4222-8222-222222222222";
    linkProjectTeamWorkspace(paths, {
      projectRoot: "/repo/koed",
      teamWorkspaceId
    });

    const result = await shareProjectCapturedSession(
      paths,
      { projectRoot: "/repo/koed", sessionId },
      {
        MEMORY_API_URL: "http://koed.test",
        MEMORY_API_TOKEN: "cmt_lookup",
        KOED_TEAM_SESSION_COOKIE: "cms_share"
      } as NodeJS.ProcessEnv,
      {},
      {
        fetch: async (url) => {
          if (String(url).includes(`/v1/sessions/${sessionId}`)) {
            return Response.json(
              { error: "Captured Session does not belong to Project" },
              { status: 404 }
            );
          }
          throw new Error(`unexpected request ${String(url)}`);
        }
      }
    );

    expect(result).toMatchObject({
      ok: false,
      state: "needs_attention",
      teamWorkspaceId
    });
    expect(result.message).toContain(
      "Captured Session does not belong to Project"
    );
  });
});

import { describe, expect, it } from "vitest";
import { workspaceProjectAuthorityUrl } from "./workspace-project-authority-url.js";
import {
  safeUpstreamProxyUrl,
  type LocalEdgeUpstreamBackend
} from "./upstream-routing.js";

const backend: LocalEdgeUpstreamBackend = {
  id: "team",
  baseUrl: "https://team.example.test/koed",
  routePolicy: {
    personalMemoryRead: "disabled",
    teamWorkspaceRead: "enabled",
    shareGrantManagement: "enabled",
    captureWrites: "disabled",
    sync: "enabled",
    admin: "disabled"
  }
};
const status = "/v1/local-edge/device-credentials/status";

describe("server-owned Workspace Project principal status URL", () => {
  it("allows the exact status read while preserving a deployment base path", () => {
    expect(workspaceProjectAuthorityUrl(backend, status).href).toBe(
      "https://team.example.test/koed/v1/local-edge/device-credentials/status"
    );
    expect(() => safeUpstreamProxyUrl(backend, status)).toThrow(
      "Unsupported upstream proxy path"
    );
  });

  it("keeps other local-edge paths and changed status selectors unavailable", () => {
    for (const path of [
      `${status}?owner=other`,
      `${status}#fragment`,
      `${status}/`,
      "/v1/local-edge/commands",
      "/v1/local-edge/../admin",
      "https://other.example.test/v1/local-edge/device-credentials/status"
    ])
      expect(() => workspaceProjectAuthorityUrl(backend, path)).toThrow();
  });

  it("rejects unsafe enrolled origins rather than forwarding credentials", () => {
    for (const baseUrl of [
      "https://user:secret@team.example.test/",
      "https://team.example.test/?key=value",
      "https://team.example.test/#fragment",
      "http://team.example.test/"
    ])
      expect(() =>
        workspaceProjectAuthorityUrl({ ...backend, baseUrl }, status)
      ).toThrow();
  });

  it("leaves ordinary upstream URL validation in place", () => {
    expect(
      workspaceProjectAuthorityUrl(backend, "/v1/workspace-projects").href
    ).toBe(safeUpstreamProxyUrl(backend, "/v1/workspace-projects").href);
  });
});

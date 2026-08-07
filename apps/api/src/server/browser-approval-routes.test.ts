import Fastify from "fastify";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerBrowserApprovalRoutes } from "./browser-approval-routes.js";

const selector = "953249fe-6002-4750-83e8-fe89268e35ac";

describe("browser approval routes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it("serves both approval pages with restrictive browser headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "koed-browser-approval-"));
    await mkdir(join(root, "assets"));
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><link href="/browser-approval/assets/index.css"><script src="/browser-approval/assets/index.js"></script><div id="root"></div>'
    );
    const app = Fastify();
    apps.push(app);
    registerBrowserApprovalRoutes(app, { assetRoot: root });

    for (const url of [
      `/high-risk/browser-activations/${selector}`,
      `/device-enrollment/${selector}`
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toContain(
        "frame-ancestors 'none'"
      );
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.body).toContain(
        url.startsWith("/high-risk")
          ? "../../browser-approval/assets/"
          : "../browser-approval/assets/"
      );
      expect(response.body).not.toContain('"/browser-approval/assets/');
    }
  });

  it("serves only flat known-type immutable assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "koed-browser-approval-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "ok");
    await writeFile(join(root, "assets", "index-abc12345.js"), "export {};");
    const app = Fastify();
    apps.push(app);
    registerBrowserApprovalRoutes(app, { assetRoot: root });
    const asset = await app.inject({
      method: "GET",
      url: "/browser-approval/assets/index-abc12345.js"
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/browser-approval/assets/%2e%2e%2fsecret"
        })
      ).statusCode
    ).toBe(404);
  });
});

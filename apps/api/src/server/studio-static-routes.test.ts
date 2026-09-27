import Fastify from "fastify";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerStudioStaticRoutes } from "./studio-static-routes.js";

describe("hosted Studio static routes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  const createRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "koed-studio-static-"));
    roots.push(root);
    return root;
  };

  it("serves exported pages and assets with same-origin browser headers", async () => {
    const root = await createRoot();
    await mkdir(join(root, "_next", "static"), { recursive: true });
    await mkdir(join(root, "settings"));
    await writeFile(join(root, "index.html"), "<html>Studio</html>");
    await writeFile(join(root, "settings.html"), "<html>Settings</html>");
    await writeFile(
      join(root, "settings", "__next.settings.__PAGE__.txt"),
      "payload"
    );
    await writeFile(join(root, "_next", "static", "main.js"), "export {};");
    const app = Fastify();
    apps.push(app);
    registerStudioStaticRoutes(app, { assetRoot: root });

    const page = await app.inject({ method: "GET", url: "/studio" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["cache-control"]).toBe("no-cache");
    expect(page.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'"
    );
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.body).toContain("Studio");

    const subroute = await app.inject({
      method: "GET",
      url: "/studio/settings"
    });
    expect(subroute.statusCode).toBe(200);
    expect(subroute.body).toContain("Settings");

    const routePayload = await app.inject({
      method: "GET",
      url: "/studio/settings/__next.settings.__PAGE__.txt"
    });
    expect(routePayload.statusCode).toBe(200);
    expect(routePayload.headers["content-type"]).toContain("text/plain");
    expect(routePayload.headers["cache-control"]).toBe("no-cache");

    const asset = await app.inject({
      method: "GET",
      url: "/studio/_next/static/main.js"
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.headers["cache-control"]).toContain("immutable");
  });

  it("blocks traversal, unknown file types, and missing files", async () => {
    const root = await createRoot();
    await writeFile(join(root, "index.html"), "<html>Studio</html>");
    await writeFile(join(root, "secret.env"), "secret");
    const app = Fastify();
    apps.push(app);
    registerStudioStaticRoutes(app, { assetRoot: root });

    for (const url of [
      "/studio/%2e%2e/secret.env",
      "/studio/%252e%252e%252fsecret.env",
      "/studio/secret.env",
      "/studio/missing.js"
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
  });

  it("does not serve symlinks that escape the configured asset root", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await writeFile(join(root, "index.html"), "<html>Studio</html>");
    await writeFile(join(outside, "secret.js"), "secret");
    await symlink(join(outside, "secret.js"), join(root, "secret.js"));
    const app = Fastify();
    apps.push(app);
    registerStudioStaticRoutes(app, { assetRoot: root });

    expect(
      (await app.inject({ method: "GET", url: "/studio/secret.js" })).statusCode
    ).toBe(404);
  });

  it("leaves non-hosted API startup without Studio artifacts unchanged", async () => {
    const app = Fastify();
    apps.push(app);
    registerStudioStaticRoutes(app, { assetRoot: "  " });

    expect(
      (await app.inject({ method: "GET", url: "/studio" })).statusCode
    ).toBe(404);
  });

  it("returns unavailable when a configured artifact root is missing", async () => {
    const app = Fastify();
    apps.push(app);
    registerStudioStaticRoutes(app, {
      assetRoot: join(tmpdir(), "koed-studio-static-absent")
    });

    expect(
      (await app.inject({ method: "GET", url: "/studio" })).statusCode
    ).toBe(503);
  });
});

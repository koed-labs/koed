import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";

import { highRiskBrowserActivationParamsSchema } from "../high-risk/schemas.js";
import { deviceEnrollmentChallengeParamsSchema } from "../local-edge/schemas.js";

const defaultAssetRoot = fileURLToPath(
  new URL("../../dist/browser-approval/", import.meta.url)
);

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

const pageHeaders = (reply: FastifyReply): void => {
  reply
    .header("cache-control", "no-store")
    .header(
      "content-security-policy",
      "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; script-src 'self'; style-src 'self'"
    )
    .header("cross-origin-opener-policy", "same-origin")
    .header("cross-origin-resource-policy", "same-origin")
    .header("permissions-policy", "camera=(), geolocation=(), microphone=()")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY");
};

const sendPage = async (
  reply: FastifyReply,
  assetRoot: string,
  browserAssetPath: string
) => {
  pageHeaders(reply);
  try {
    const html = await readFile(resolve(assetRoot, "index.html"), "utf8");
    return reply
      .type("text/html; charset=utf-8")
      .send(html.replaceAll('"/browser-approval/', `"${browserAssetPath}`));
  } catch {
    return reply
      .status(503)
      .type("text/plain; charset=utf-8")
      .send("Approval page is unavailable.");
  }
};

export const registerBrowserApprovalRoutes = (
  app: FastifyInstance,
  options: { assetRoot?: string } = {}
): void => {
  const assetRoot = options.assetRoot ?? defaultAssetRoot;

  app.get(
    "/high-risk/browser-activations/:selector",
    async (request, reply) => {
      highRiskBrowserActivationParamsSchema.parse(request.params);
      return sendPage(reply, assetRoot, "../../browser-approval/");
    }
  );

  app.get("/device-enrollment/:challengeId", async (request, reply) => {
    deviceEnrollmentChallengeParamsSchema.parse(request.params);
    return sendPage(reply, assetRoot, "../browser-approval/");
  });

  app.get("/browser-approval/assets/*", async (request, reply) => {
    const name = (request.params as { "*"?: string })["*"] ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      return reply.status(404).send({ error: "Asset not found" });
    }
    const contentType = contentTypes[extname(name).toLowerCase()];
    if (!contentType) {
      return reply.status(404).send({ error: "Asset not found" });
    }
    try {
      const asset = await readFile(resolve(assetRoot, "assets", name));
      return reply
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("cross-origin-resource-policy", "same-origin")
        .header("x-content-type-options", "nosniff")
        .type(contentType)
        .send(asset);
    } catch {
      return reply.status(404).send({ error: "Asset not found" });
    }
  });
};

/* global process, Buffer, console */
import { createServer } from "node:http";
import {
  authenticate,
  createKmsClient,
  manifestDigest,
  signingMessage,
  verifyEnvelope
} from "./service.mjs";

const config = {
  keyId: process.env.KOED_SIGNER_KEY_ID,
  keyVersion: process.env.KOED_SIGNER_KMS_KEY_VERSION,
  repositoryId: process.env.KOED_SIGNER_REPOSITORY_ID,
  ownerId: process.env.KOED_SIGNER_OWNER_ID
};
if (
  !config.keyId ||
  !/^[A-Za-z0-9_-]{1,64}$/.test(config.keyId) ||
  !/^projects\/[a-z0-9-]+\/locations\/europe-west2\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/\d+$/.test(
    config.keyVersion ?? ""
  ) ||
  !/^\d+$/.test(config.repositoryId ?? "") ||
  !/^\d+$/.test(config.ownerId ?? "")
)
  throw new Error("Signing service configuration is invalid");
const kms = createKmsClient(config);
const server = createServer(async (req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store"
    });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health")
    return reply(200, { ok: true });
  if (req.method !== "POST" || !["/v1/sign", "/v1/verify"].includes(req.url))
    return reply(404, { error: "Not found" });
  let claims;
  try {
    claims = await authenticate(req.headers.authorization, config);
  } catch {
    return reply(403, { error: "Unauthorized workflow" });
  }
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? ""))
    return reply(415, { error: "JSON required" });
  let body;
  let message;
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reply(413, { error: "Request exceeds 8 MiB" });
        req.resume();
        return;
      }
      chunks.push(chunk);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const allowed =
      req.url === "/v1/sign" ? "keyId,manifest" : "keyId,manifest,signature";
    if (Object.keys(body).sort().join() !== allowed)
      throw new Error("Invalid request fields");
    message = signingMessage(body, config);
  } catch {
    return reply(400, { error: "Invalid component request" });
  }
  try {
    if (req.url === "/v1/verify")
      return reply(200, {
        verified: verifyEnvelope(
          body.signature,
          message,
          config,
          await kms.publicKey()
        )
      });
    const signature = await kms.sign(message);
    console.log(
      JSON.stringify({
        event: "component_signed",
        repositoryId: claims.repository_id,
        workflow: claims.workflow_ref,
        runId: claims.run_id,
        keyId: config.keyId,
        manifestDigest: manifestDigest(body.manifest)
      })
    );
    return reply(200, { signature });
  } catch (error) {
    console.error(
      JSON.stringify({ event: "kms_failure", message: error.message })
    );
    return reply(502, { error: "Signing backend unavailable" });
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
process.on("SIGTERM", () => server.close());

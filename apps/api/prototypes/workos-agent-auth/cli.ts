import { createPrototype } from "./server.js";
import type { RegistrationConfig } from "./workos.js";

const mode = process.env.KOED_AUTH_PROTOTYPE_MODE ?? "fixture";
if (mode !== "fixture" && mode !== "workos-staging")
  throw new Error(
    "Mode must be fixture or workos-staging; production is not supported"
  );
const port = Number(process.env.KOED_AUTH_PROTOTYPE_PORT ?? 43555);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Choose a local port between 1024 and 65535");
const origin = `http://127.0.0.1:${port}`;
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
let staging: RegistrationConfig | undefined;
if (mode === "workos-staging") {
  if (process.env.KOED_AUTH_PROTOTYPE_STAGING_CONFIRMED !== "1")
    throw new Error(
      "Confirm the WorkOS environment is staging before enabling network calls"
    );
  staging = {
    issuer: required("WORKOS_PROTOTYPE_AUTHKIT_URL"),
    apiKey: required("WORKOS_PROTOTYPE_API_KEY"),
    organizationId: required("WORKOS_PROTOTYPE_ORGANIZATION_ID"),
    workosUserId: required("WORKOS_PROTOTYPE_USER_ID"),
    koedUserId: "7c07a3cc-5679-4df2-bb67-c86571df93c2",
    resource: `${origin}/mcp`,
    maxRequests: 40
  };
}
const { app } = createPrototype({ origin, staging });
await app.listen({ host: "127.0.0.1", port });
console.log(
  JSON.stringify({
    mode,
    url: origin,
    authInstructions: `${origin}/auth.md`,
    syntheticDataOnly: true
  })
);
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void app.close().catch(() => {
    process.exitCode = 1;
  });
};
process.once("SIGINT", close);
process.once("SIGTERM", close);

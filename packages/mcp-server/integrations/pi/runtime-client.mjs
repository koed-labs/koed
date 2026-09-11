/* global fetch */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";

export const callLocalRuntimeTool = async ({
  koedHome,
  name,
  input,
  context,
  signal,
  invocationKey
}) => {
  const registration = JSON.parse(
    readFileSync(join(koedHome, "run", "local-ai-runtime.json"), "utf8")
  );
  if (
    typeof registration.url !== "string" ||
    typeof registration.authorization !== "string"
  ) {
    throw new Error("Koed Local AI Runtime registration is invalid");
  }
  const response = await fetch(new URL(`/v1/tools/${name}`, registration.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: registration.authorization
    },
    body: JSON.stringify({
      input,
      caller: {
        cwd: context.cwd,
        clientInfo: { name: "pi", version: "koed-extension-v1" }
      },
      invocationKey
    }),
    signal
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : `Koed Local AI Runtime returned HTTP ${response.status}`
    );
  }
  return body;
};

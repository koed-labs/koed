import { Buffer } from "node:buffer";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function validChatModelPreference(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.modelKey === "string" &&
    value.modelKey.trim() &&
    value.modelKey.length <= 512 &&
    typeof value.effort === "string" &&
    value.effort.length <= 40
  );
}

export async function handleChatModelPreferences({
  request,
  url,
  validCsrf,
  send,
  koedHome
}) {
  if (url.pathname !== "/studio-api/chat-model-preferences") return false;
  if (url.search) {
    send(400, { error: "query_not_allowed" });
    return true;
  }
  const file = path.join(koedHome, "studio-chat-model-preferences.json");
  if (request.method === "GET") {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      send(200, {
        preference: validChatModelPreference(value)
          ? { modelKey: value.modelKey, effort: value.effort }
          : null
      });
    } catch {
      send(200, { preference: null });
    }
    return true;
  }
  if (request.method !== "PUT") {
    send(405, { error: "method_not_allowed" });
    return true;
  }
  if (!validCsrf(request)) {
    send(403, { error: "invalid_csrf" });
    return true;
  }
  if (
    !String(request.headers["content-type"] ?? "").startsWith(
      "application/json"
    )
  ) {
    send(415, { error: "json_required" });
    return true;
  }
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024) {
        send(413, { error: "body_too_large" });
        return true;
      }
      chunks.push(Buffer.from(chunk));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!validChatModelPreference(value)) {
      send(400, { error: "invalid_preference" });
      return true;
    }
    await mkdir(koedHome, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({ modelKey: value.modelKey, effort: value.effort }),
      { mode: 0o600 }
    );
    await rename(temporary, file);
    send(200, { saved: true });
  } catch {
    send(400, { error: "preference_not_saved" });
  }
  return true;
}

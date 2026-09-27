import { lstat, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";

const uuid =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const route = new RegExp(
  `^/studio-api/managed-conversations/(${uuid})/retained-workspaces(?:/(${uuid})/(open|delete))?$`
);

const retainedDirectoryAvailable = async (path) => {
  try {
    const stat = await lstat(path);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (await realpath(path)) === path
    );
  } catch {
    return false;
  }
};

export const openRetainedWorkspaceFolder = async (path) => {
  if (!(await retainedDirectoryAvailable(path)))
    throw new Error("retained_workspace_unavailable");
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  await new Promise((resolve, reject) => {
    const child = spawn(command, [path], {
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("retained_workspace_open_failed"))
    );
  });
};

/** Local Studio only. Never proxy this route to hosted Koed. */
export async function handleRetainedWorkspaces({
  request,
  url,
  catalog,
  validSession,
  validWrite,
  openFolder = openRetainedWorkspaceFolder,
  deleteManagedWorktree,
  send
}) {
  const match = route.exec(url.pathname);
  if (!match) return false;
  const [, executionId, moveId, action] = match;
  if (url.search) {
    send(400, { error: "query_not_allowed" });
    return true;
  }
  if (request.method !== (moveId ? "POST" : "GET")) {
    send(405, { error: "method_not_allowed" });
    return true;
  }
  if (!(moveId ? validWrite(request) : validSession(request))) {
    send(403, { error: "forbidden" });
    return true;
  }
  if (moveId) {
    if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
      send(415, { error: "unsupported_media_type" });
      return true;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1024) {
        send(413, { error: "body_too_large" });
        return true;
      }
      chunks.push(Buffer.from(chunk));
    }
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        (action === "delete"
          ? Object.keys(payload).length !== 1 ||
            payload.confirmation !== "delete_managed_worktree"
          : Object.keys(payload).length !== 0)
      )
        throw new Error("invalid_payload");
    } catch {
      send(400, { error: "invalid_payload" });
      return true;
    }
  }
  try {
    if (!moveId) {
      const records = catalog
        .list()
        .filter((record) => record.executionId === executionId);
      const workspaces = await Promise.all(
        records.map(async (record) => ({
          moveId: record.moveId,
          sourceProjectId: record.sourceProjectId,
          sourcePath: record.sourcePath,
          reason: record.reason,
          retainedAt: record.retainedAt,
          available: await retainedDirectoryAvailable(record.sourcePath),
          checkoutKind: record.checkoutKind ?? "unknown",
          deletable:
            record.checkoutKind === "koed_managed_worktree" &&
            record.checkoutIdentity?.ownership === "koed_managed_worktree" &&
            record.checkoutIdentity?.canonicalPath === record.sourcePath
        }))
      );
      send(200, { workspaces });
      return true;
    }
    const record = catalog.read(moveId);
    if (!record || record.executionId !== executionId) {
      send(404, { error: "not_found" });
      return true;
    }
    if (action === "delete") {
      if (
        record.checkoutKind !== "koed_managed_worktree" ||
        !record.checkoutIdentity ||
        typeof deleteManagedWorktree !== "function"
      ) {
        send(409, { error: "retained_workspace_not_deletable" });
        return true;
      }
      const deleted = await deleteManagedWorktree(moveId);
      send(
        deleted ? 200 : 404,
        deleted ? { deleted: true } : { error: "not_found" }
      );
    } else {
      await openFolder(record.sourcePath);
      send(200, { opened: true });
    }
  } catch {
    send(503, { error: "retained_workspace_unavailable" });
  }
  return true;
}

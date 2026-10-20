import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureDeviceIdentity,
  readSourceFolderObservation,
  readCurrentSourceFolderObservation,
  resolveKoedServerPaths
} from "@koed-labs/server";
import { recordCaptureHookFolder } from "../src/capture-hook.js";
import { recordedCaptureFolderObservation } from "../src/capture-repository-context.js";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("native Capture Hook Folder evidence", () => {
  it.each(["codex", "claude"] as const)(
    "carries %s source-time identity and keeps later cwd observations separate",
    async (provider) => {
      const parent = resolve(
        import.meta.dirname,
        "../../../scratch/p1-06/hooks"
      );
      mkdirSync(parent, { recursive: true });
      const root = mkdtempSync(resolve(parent, "capture-"));
      temporary.push(root);
      const env = {
        NODE_ENV: "test",
        KOED_HOME: resolve(root, "profile"),
        KOED_REPO_ROOT: root
      };
      const paths = resolveKoedServerPaths(env);
      await ensureDeviceIdentity(paths, { environment: env });
      const cwd = resolve(root, "checkout"),
        sub = resolve(cwd, "sub");
      mkdirSync(sub, { recursive: true });
      const args = ["--source", provider];
      const key = {
        sourceKind:
          provider === "codex" ? ("codex" as const) : ("claude-code" as const),
        externalSessionId: "native-session"
      };
      await recordCaptureHookFolder(
        env,
        {
          sourceSessionId: key.externalSessionId,
          cwd,
          hookEventName: "SessionStart",
          sessionStartSource: "startup"
        },
        args
      );
      const original = readSourceFolderObservation(paths, key);
      expect(original?.normalizedPath).toBe(cwd);
      await recordCaptureHookFolder(
        env,
        {
          sourceSessionId: key.externalSessionId,
          cwd: sub,
          hookEventName: "Stop"
        },
        args
      );
      expect(readSourceFolderObservation(paths, key)).toEqual(original);
      expect(
        readCurrentSourceFolderObservation(paths, key)?.normalizedPath
      ).toBe(sub);
      const unknown = { ...key, externalSessionId: "previously-uncaptured" };
      await recordCaptureHookFolder(
        env,
        {
          sourceSessionId: unknown.externalSessionId,
          cwd: sub,
          hookEventName: "SessionStart",
          sessionStartSource: "resume"
        },
        args
      );
      expect(readSourceFolderObservation(paths, unknown)).toBeUndefined();
      rmSync(cwd, { recursive: true });
      expect(recordedCaptureFolderObservation({ ...key, env })).toEqual(
        original
      );
      expect(
        recordedCaptureFolderObservation({ ...unknown, env })
      ).toBeUndefined();
    }
  );
});

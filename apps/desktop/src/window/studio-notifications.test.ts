import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStudioNotificationController,
  createStudioNotificationPreferenceStore,
  type StudioNativeNotification,
  type ResolvedStudioNotification
} from "./studio-notifications.js";

class Notice extends EventEmitter implements StudioNativeNotification {
  shown = false;
  closed = false;
  show() {
    this.shown = true;
  }
  close() {
    this.closed = true;
    this.emit("close");
  }
}

const intent = {
  version: 1 as const,
  source: "home" as const,
  accountScope: "renderer-scope",
  backendId: "renderer-backend",
  sourceEventId: "job:one",
  sourceRevision: "v1"
};
const resolved: ResolvedStudioNotification = {
  preferenceScope: "verified-account-scope",
  classification: "agent_input",
  destination: {
    kind: "execution",
    executionId: "11111111-1111-4111-8111-111111111111"
  }
};
const memoryPreferences = () => {
  const values = new Map<string, boolean>();
  return {
    values,
    get: async (scope: string) => values.get(scope) === true,
    set: async (scope: string, enabled: boolean) => {
      values.set(scope, enabled);
    }
  };
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

describe("Studio native notifications", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true }))
    );
  });

  it("stores opt-in without persisting account scope or notification content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "koed-notifications-"));
    tempDirs.push(directory);
    const path = join(directory, "prefs.json");
    const store = createStudioNotificationPreferenceStore(path);
    await Promise.all([
      store.set("home\0owner-a", true),
      store.set("team\0account-b", true),
      store.set("home\0owner-a", false)
    ]);
    expect(await store.get("home\0owner-a")).toBe(false);
    expect(await store.get("team\0account-b")).toBe(true);
    const contents = await readFile(path, "utf8");
    expect(contents).not.toContain("owner-a");
    expect(contents).not.toContain("account-b");
  });

  it("requires verified current scope, opt-in, and hidden/unfocused state", async () => {
    const preferences = memoryPreferences();
    const created: Notice[] = [];
    const controller = createStudioNotificationController({
      resolve: async () => resolved,
      getPreferenceScopes: async () => ["home\0verified-account-scope"],
      preferences,
      createNativeNotification: () => {
        const notice = new Notice();
        created.push(notice);
        return notice;
      },
      canShowNativeNotification: () => false,
      openStudio: vi.fn(async () => undefined)
    });
    expect(await controller.notify(intent)).toEqual({ shown: false });
    await preferences.set("home\0verified-account-scope", true);
    expect(await controller.notify(intent)).toEqual({ shown: false });
    expect(created).toHaveLength(0);
    controller.dispose();
  });

  it("revalidates source before display and again before navigation", async () => {
    const preferences = memoryPreferences();
    await preferences.set("home\0verified-account-scope", true);
    const notice = new Notice();
    const openStudio = vi.fn(async () => undefined);
    let resolveCount = 0;
    const controller = createStudioNotificationController({
      resolve: async () => {
        resolveCount += 1;
        return resolved;
      },
      getPreferenceScopes: async () => ["home\0verified-account-scope"],
      preferences,
      createNativeNotification: () => notice,
      canShowNativeNotification: () => true,
      openStudio
    });
    expect(await controller.notify(intent)).toEqual({ shown: true });
    expect(resolveCount).toBe(2);
    notice.emit("click");
    await vi.waitFor(() =>
      expect(openStudio).toHaveBeenCalledWith(resolved.destination)
    );
    expect(resolveCount).toBe(3);
    controller.dispose();
  });

  it("deduplicates each grouped message independently and rejects stale clicks", async () => {
    const preferences = memoryPreferences();
    await preferences.set("team_overview\0verified-account-scope", true);
    const notices: Notice[] = [];
    let current: ResolvedStudioNotification | null = resolved;
    const openStudio = vi.fn(async () => undefined);
    const controller = createStudioNotificationController({
      resolve: async () => current,
      getPreferenceScopes: async () => [
        "team_overview\0verified-account-scope"
      ],
      preferences,
      createNativeNotification: () => {
        const notice = new Notice();
        notices.push(notice);
        return notice;
      },
      canShowNativeNotification: () => true,
      openStudio
    });
    const teamIntent = {
      version: 1 as const,
      source: "team_overview" as const,
      accountScope: "renderer-scope",
      backendId: null,
      sourceEventId: "dm:thread",
      sourceRevision: "g1",
      messageId: "11111111-1111-4111-8111-111111111111"
    };
    await controller.notify(teamIntent);
    await controller.notify({
      ...teamIntent,
      messageId: "22222222-2222-4222-8222-222222222222"
    });
    expect(notices).toHaveLength(2);
    current = null;
    notices[0]!.emit("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openStudio).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("resets one source without closing the other source's notice", async () => {
    const preferences = memoryPreferences();
    await preferences.set("home\0verified-account-scope", true);
    await preferences.set("team_overview\0verified-account-scope", true);
    const notices: Notice[] = [];
    const controller = createStudioNotificationController({
      resolve: async () => resolved,
      getPreferenceScopes: async () => [
        "home\0verified-account-scope",
        "team_overview\0verified-account-scope"
      ],
      preferences,
      createNativeNotification: () => {
        const notice = new Notice();
        notices.push(notice);
        return notice;
      },
      canShowNativeNotification: () => true,
      openStudio: vi.fn(async () => undefined)
    });
    await controller.notify(intent);
    await controller.notify({
      version: 1,
      source: "team_overview",
      accountScope: "renderer-team-scope",
      backendId: null,
      sourceEventId: "dm:thread",
      sourceRevision: "g1",
      messageId: "11111111-1111-4111-8111-111111111111"
    });
    controller.reset("home");
    expect(notices[0]!.closed).toBe(true);
    expect(notices[1]!.closed).toBe(false);
    controller.dispose();
  });

  it("does not show if the authority is revoked during preference lookup", async () => {
    const waiting = deferred<boolean>();
    const notice = new Notice();
    const controller = createStudioNotificationController({
      resolve: async () => resolved,
      getPreferenceScopes: async () => ["home\0verified-account-scope"],
      preferences: {
        get: () => waiting.promise,
        set: async () => undefined
      },
      createNativeNotification: () => notice,
      canShowNativeNotification: () => true,
      openStudio: vi.fn(async () => undefined)
    });
    const pending = controller.notify(intent);
    controller.reset();
    waiting.resolve(true);
    expect(await pending).toEqual({ shown: false });
    expect(notice.shown).toBe(false);
    controller.dispose();
  });

  it("closes outstanding OS notices when reset or disposed", async () => {
    const preferences = memoryPreferences();
    await preferences.set("home\0verified-account-scope", true);
    const notice = new Notice();
    const controller = createStudioNotificationController({
      resolve: async () => resolved,
      getPreferenceScopes: async () => ["home\0verified-account-scope"],
      preferences,
      createNativeNotification: () => notice,
      canShowNativeNotification: () => true,
      openStudio: vi.fn(async () => undefined)
    });
    await controller.notify(intent);
    controller.reset();
    expect(notice.closed).toBe(true);
    controller.dispose();
  });
});

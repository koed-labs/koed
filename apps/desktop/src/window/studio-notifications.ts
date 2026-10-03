import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  studioNotificationCopy,
  studioNotificationIntentSchema,
  type StudioNotificationClassification,
  type StudioNotificationIntent,
  type StudioNotificationNavigation,
  type StudioNotificationSource
} from "@koed/shared/studio-notifications";

export type StudioNotificationDestination = StudioNotificationNavigation;

export interface ResolvedStudioNotification {
  /** Opaque scope derived from a fresh authenticated source read. */
  preferenceScope: string;
  classification: StudioNotificationClassification;
  destination: StudioNotificationDestination;
}

export interface StudioNativeNotification {
  on(event: "click" | "close", listener: () => void): this;
  show(): void;
  close(): void;
}

export interface StudioNotificationPreferenceStore {
  get(scope: string): Promise<boolean>;
  set(scope: string, enabled: boolean): Promise<void>;
}

export const createStudioNotificationPreferenceStore = (
  path: string
): StudioNotificationPreferenceStore => {
  const scopeKey = (scope: string): string =>
    createHash("sha256").update(scope).digest("hex");
  let mutationQueue = Promise.resolve();
  const read = async (): Promise<Record<string, boolean>> => {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"));
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        (parsed as { version?: unknown }).version !== 1 ||
        !(
          (parsed as { values?: unknown }).values &&
          typeof (parsed as { values?: unknown }).values === "object" &&
          !Array.isArray((parsed as { values?: unknown }).values)
        )
      )
        return {};
      const values = (parsed as { values: Record<string, unknown> }).values;
      const safeValues: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(values)) {
        if (/^[a-f0-9]{64}$/u.test(key) && typeof value === "boolean")
          safeValues[key] = value;
      }
      return safeValues;
    } catch {
      return {};
    }
  };
  const write = async (values: Record<string, boolean>): Promise<void> => {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ version: 1, values }), {
      encoding: "utf8",
      mode: 0o600
    });
    await fs.rename(temporary, path);
  };
  return {
    get: async (scope) => (await read())[scopeKey(scope)] === true,
    set: async (scope, enabled) => {
      const mutation = mutationQueue.then(async () => {
        const values = await read();
        values[scopeKey(scope)] = enabled;
        await write(values);
      });
      mutationQueue = mutation.catch(() => undefined);
      await mutation;
    }
  };
};

export interface StudioNotificationControllerOptions {
  resolve: (
    intent: StudioNotificationIntent
  ) => Promise<ResolvedStudioNotification | null>;
  getPreferenceScopes: () => Promise<string[]>;
  preferences: StudioNotificationPreferenceStore;
  createNativeNotification: (copy: {
    title: string;
    body: string;
  }) => StudioNativeNotification;
  canShowNativeNotification: () => boolean;
  openStudio: (destination: StudioNotificationDestination) => Promise<void>;
}

export const createStudioNotificationController = (
  options: StudioNotificationControllerOptions
) => {
  const active = new Map<StudioNativeNotification, StudioNotificationSource>();
  const seen = new Set<string>();
  const sourceGenerations = new Map<StudioNotificationSource, number>([
    ["home", 0],
    ["team_overview", 0]
  ]);
  let disposed = false;
  let generation = 0;
  const getPreference = async (): Promise<{ enabled: boolean }> => {
    const scopes = await options.getPreferenceScopes();
    if (!scopes.length) return { enabled: false };
    const enabled = await Promise.all(
      scopes.map((scope) => options.preferences.get(scope))
    );
    return { enabled: enabled.some(Boolean) };
  };
  const setEnabled = async (
    enabled: boolean
  ): Promise<{ enabled: boolean }> => {
    if (typeof enabled !== "boolean")
      throw new Error("Notification preference must be boolean.");
    const scopes = await options.getPreferenceScopes();
    await Promise.all(
      scopes.map((scope) => options.preferences.set(scope, enabled))
    );
    return { enabled: scopes.length > 0 && enabled };
  };
  const notify = async (value: unknown): Promise<{ shown: boolean }> => {
    if (disposed) return { shown: false };
    const intent = studioNotificationIntentSchema.parse(value);
    const requestGeneration = generation;
    const requestSourceGeneration = sourceGenerations.get(intent.source) ?? 0;
    // Resolve before reading preference so a forged scope can never select the
    // account whose opt-in is consulted.
    let resolved: ResolvedStudioNotification | null;
    try {
      resolved = await options.resolve(intent);
    } catch {
      return { shown: false };
    }
    if (!resolved) return { shown: false };
    const prefixedScope = `${intent.source}\0${resolved.preferenceScope}`;
    if (!(await options.preferences.get(prefixedScope)))
      return { shown: false };
    if (
      disposed ||
      requestGeneration !== generation ||
      requestSourceGeneration !== sourceGenerations.get(intent.source)
    )
      return { shown: false };
    // A preference read may take long enough for access or source state to
    // change. Resolve again immediately before constructing the OS notice.
    let current: ResolvedStudioNotification | null;
    try {
      current = await options.resolve(intent);
    } catch {
      return { shown: false };
    }
    if (
      disposed ||
      requestGeneration !== generation ||
      requestSourceGeneration !== sourceGenerations.get(intent.source) ||
      !current ||
      current.preferenceScope !== resolved.preferenceScope ||
      current.classification !== resolved.classification ||
      JSON.stringify(current.destination) !==
        JSON.stringify(resolved.destination)
    )
      return { shown: false };
    if (!options.canShowNativeNotification()) return { shown: false };
    const dedupKey = `${prefixedScope}\0${intent.sourceEventId}\0${intent.sourceRevision}\0${intent.messageId ?? ""}`;
    if (seen.has(dedupKey)) return { shown: false };
    seen.add(dedupKey);
    while (seen.size > 500) seen.delete(seen.values().next().value!);
    const notice = options.createNativeNotification(
      studioNotificationCopy(resolved.classification)
    );
    active.set(notice, intent.source);
    notice.on("close", () => active.delete(notice));
    const noticeGeneration = requestGeneration;
    const noticeSourceGeneration = requestSourceGeneration;
    notice.on("click", () => {
      void options
        .resolve(intent)
        .then(async (current) => {
          if (
            !disposed &&
            noticeGeneration === generation &&
            noticeSourceGeneration === sourceGenerations.get(intent.source) &&
            current &&
            current.preferenceScope === resolved.preferenceScope &&
            current.classification === resolved.classification &&
            JSON.stringify(current.destination) ===
              JSON.stringify(resolved.destination)
          ) {
            await options.openStudio(current.destination);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          notice.close();
          active.delete(notice);
        });
    });
    notice.show();
    return { shown: true };
  };
  const reset = (source?: StudioNotificationSource): void => {
    if (source) {
      sourceGenerations.set(source, (sourceGenerations.get(source) ?? 0) + 1);
      const prefix = `${source}\0`;
      for (const key of seen) if (key.startsWith(prefix)) seen.delete(key);
      for (const [notice, noticeSource] of active) {
        if (noticeSource === source) {
          notice.close();
          active.delete(notice);
        }
      }
      return;
    }
    generation += 1;
    seen.clear();
    for (const notice of active.keys()) notice.close();
    active.clear();
  };
  const dispose = (): void => {
    disposed = true;
    reset();
  };
  return { getPreference, setEnabled, notify, reset, dispose };
};

export const studioNotificationPreferencePath = (
  userDataPath: string
): string => resolve(userDataPath, "studio-notification-preferences.json");

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type PiDiscoveryInput = {
  cwd: string;
  sdkEntryPath: string;
  configHome: string | null;
};

type PiDiscoveredResource = {
  kind: "skill" | "extension";
  name: string;
  description?: string;
  path: string;
  source: "user" | "plugin";
  status: "ready" | "disabled" | "unavailable";
};

const maxResources = 500;
const maxDescription = 1_000;

const replaceControlCharacters = (value: string): string =>
  Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("");

const statusText = (value: unknown): string =>
  typeof value === "string" ? value.toLowerCase() : "";

const safeName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 &&
    name.length <= 160 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    name === replaceControlCharacters(name)
    ? name
    : null;
};

const safeDescription = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const description = replaceControlCharacters(value)
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s,;]+[\\/])+[^\s,;]*/gu, "[path]")
    .replace(
      /\b(?:bearer\s+)?(?:sk|gh[pousr]|xox[baprs])-[-A-Za-z0-9_]{12,}\b/giu,
      "[redacted]"
    )
    .trim()
    .slice(0, maxDescription);
  return description || undefined;
};

const configuredExtensions = (values: unknown): PiDiscoveredResource[] => {
  if (!Array.isArray(values)) return [];
  return values.slice(0, maxResources).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const name = safeName(item.name ?? item.id);
    if (!name) return [];
    const nativePath =
      typeof item.path === "string" && path.isAbsolute(item.path)
        ? item.path
        : `pi-extension:${name}`;
    const resourceStatusText = statusText(item.status ?? item.state);
    const status =
      item.enabled === false ||
      item.disabled === true ||
      /disabled|off/u.test(resourceStatusText)
        ? "disabled"
        : /unavailable|error|failed/u.test(resourceStatusText)
          ? "unavailable"
          : "ready";
    return [
      {
        kind: "extension",
        name,
        ...(safeDescription(item.description)
          ? { description: safeDescription(item.description) }
          : {}),
        path: nativePath,
        source: "plugin",
        status
      }
    ];
  });
};

const discover = async (
  input: PiDiscoveryInput
): Promise<PiDiscoveredResource[]> => {
  if (
    !path.isAbsolute(input.cwd) ||
    !path.isAbsolute(input.sdkEntryPath) ||
    (input.configHome !== null && !path.isAbsolute(input.configHome))
  )
    throw new Error("Pi SDK unavailable");
  const sdkEntryPath = fs.realpathSync(input.sdkEntryPath);
  const sdk = (await import(pathToFileURL(sdkEntryPath).href)) as {
    getAgentDir: () => string;
    DefaultResourceLoader: new (options: Record<string, unknown>) => {
      reload(): Promise<void>;
      getSkills(): { skills?: Array<Record<string, unknown>> };
      getExtensions(): { extensions?: Array<Record<string, unknown>> };
    };
  };
  const loader = new sdk.DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.configHome ?? sdk.getAgentDir()
  });
  await loader.reload();
  const skills = (loader.getSkills().skills ?? [])
    .slice(0, maxResources)
    .flatMap((skill) => {
      const name = safeName(skill.name);
      const skillPath =
        typeof skill.filePath === "string"
          ? skill.filePath
          : typeof skill.path === "string"
            ? skill.path
            : "";
      if (!name || !path.isAbsolute(skillPath)) return [];
      return [
        {
          kind: "skill" as const,
          name,
          ...(safeDescription(skill.description)
            ? { description: safeDescription(skill.description) }
            : {}),
          path: fs.realpathSync(skillPath),
          source: "user" as const,
          status: "ready" as const
        }
      ];
    });
  return [
    ...skills,
    ...configuredExtensions(loader.getExtensions().extensions)
  ].slice(0, maxResources);
};

const childProcess = process as NodeJS.Process & {
  send?: (
    message: unknown,
    callback?: (error: Error | null) => void
  ) => boolean;
};

childProcess.on("message", (message: unknown) => {
  void (async () => {
    try {
      const resources = await discover(message as PiDiscoveryInput);
      const payload = { ok: true as const, resources };
      if (JSON.stringify(payload).length > 1024 * 1024)
        throw new Error("Pi catalog too large");
      childProcess.send?.(payload, () => process.exit(0));
    } catch {
      childProcess.send?.(
        { ok: false, errorCode: "AiClientPiUnavailable" },
        () => process.exit(1)
      );
    }
  })();
});

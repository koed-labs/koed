import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeManagedPluginSkillSelection {
  /** Exact native command name, for example `plugin-name:skill-name`. */
  name: string;
  /** Whether the provider path is a manifest-backed plugin or a raw `.claude` root. */
  providerKind: "plugin" | "claude_root";
  /** Private canonical plugin root returned by native resource revalidation. */
  providerPath: string;
}

export interface ClaudeManagedPluginSkillOptions {
  plugins: NonNullable<Options["plugins"]>;
  skills: string[];
  disallowedTools: string[];
  settings: {
    disableAllHooks: true;
    permissions: { ask: ["*"] };
  };
}

export class ClaudeManagedPluginSkillBridgeError extends Error {
  constructor() {
    super(
      "Selected Claude Skills require a verified native Claude definition while filesystem settings are disabled."
    );
    this.name = "ClaudeManagedPluginSkillBridgeError";
  }
}

const MAX_PLUGIN_MANIFEST_BYTES = 32 * 1024;
const MAX_SKILL_FRONTMATTER_BYTES = 16 * 1024;
const MAX_SKILL_DIRECTORIES = 128;
const MAX_SKILL_ROOT_SCAN_BYTES =
  MAX_SKILL_FRONTMATTER_BYTES * MAX_SKILL_DIRECTORIES;
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
// eslint-disable-next-line no-control-regex -- Native command names must reject control bytes.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const SAFE_PLUGIN_MANIFEST_KEYS = new Set([
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords"
]);
const SAFE_SKILL_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  // The SDK loads this permission hint from a Skill. An inline ask-all rule
  // routes every tool call through the host callback before this hint applies.
  "allowed-tools"
]);
const FORBIDDEN_PLUGIN_ENTRIES = new Set(["agents", "commands"]);

const fail = (): never => {
  throw new ClaudeManagedPluginSkillBridgeError();
};

export interface ClaudeManagedSkillScanBudget {
  remainingBytes: number;
}

export interface ClaudeManagedSkillRootInventory {
  providerPath: string;
  namespace: string;
  skillNames: readonly string[];
}

const readPluginManifest = (pluginRoot: string): Record<string, unknown> => {
  const metadataDirectory = path.join(pluginRoot, ".claude-plugin");
  const manifestPath = path.join(metadataDirectory, "plugin.json");

  try {
    const metadataDirectoryInfo = fs.lstatSync(metadataDirectory);
    if (
      metadataDirectoryInfo.isSymbolicLink() ||
      !metadataDirectoryInfo.isDirectory() ||
      fs.realpathSync(metadataDirectory) !== metadataDirectory
    ) {
      return fail();
    }
    const manifestInfo = fs.lstatSync(manifestPath);
    if (
      manifestInfo.isSymbolicLink() ||
      !manifestInfo.isFile() ||
      manifestInfo.size > MAX_PLUGIN_MANIFEST_BYTES
    ) {
      return fail();
    }

    const noFollow = constants.O_NOFOLLOW ?? 0;
    const descriptor = openSync(manifestPath, constants.O_RDONLY | noFollow);
    try {
      const openedInfo = fstatSync(descriptor);
      if (
        !openedInfo.isFile() ||
        openedInfo.dev !== manifestInfo.dev ||
        openedInfo.ino !== manifestInfo.ino ||
        openedInfo.size > MAX_PLUGIN_MANIFEST_BYTES
      ) {
        return fail();
      }

      const bytes = Buffer.alloc(MAX_PLUGIN_MANIFEST_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(
          descriptor,
          bytes,
          length,
          bytes.length - length,
          null
        );
        if (count === 0) break;
        length += count;
      }
      if (length > MAX_PLUGIN_MANIFEST_BYTES) return fail();

      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length)
        );
      } catch {
        return fail();
      }
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return fail();
      }
      const manifest = parsed as Record<string, unknown>;
      if (
        Object.keys(manifest).some((key) => !SAFE_PLUGIN_MANIFEST_KEYS.has(key))
      ) {
        return fail();
      }
      return manifest;
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return fail();
  }
};

const readClaudeSkillDefinition = (
  skillFilePath: string,
  expectedName?: string,
  budget?: ClaudeManagedSkillScanBudget
): string => {
  try {
    const fileInfo = fs.lstatSync(skillFilePath);
    if (
      fileInfo.isSymbolicLink() ||
      !fileInfo.isFile() ||
      fileInfo.size > MAX_SKILL_FRONTMATTER_BYTES ||
      fs.realpathSync(skillFilePath) !== skillFilePath
    ) {
      return fail();
    }

    const noFollow = constants.O_NOFOLLOW ?? 0;
    const descriptor = openSync(skillFilePath, constants.O_RDONLY | noFollow);
    try {
      const openedInfo = fstatSync(descriptor);
      if (
        !openedInfo.isFile() ||
        openedInfo.dev !== fileInfo.dev ||
        openedInfo.ino !== fileInfo.ino ||
        openedInfo.size > MAX_SKILL_FRONTMATTER_BYTES ||
        openedInfo.size !== fileInfo.size ||
        (budget !== undefined && openedInfo.size > budget.remainingBytes)
      ) {
        return fail();
      }
      if (budget !== undefined) budget.remainingBytes -= openedInfo.size;
      const bytes = Buffer.alloc(MAX_SKILL_FRONTMATTER_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(
          descriptor,
          bytes,
          length,
          bytes.length - length,
          null
        );
        if (count === 0) break;
        length += count;
      }
      if (length > MAX_SKILL_FRONTMATTER_BYTES) return fail();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length)
      );
      const frontmatter = text.match(
        /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u
      )?.[1];
      if (!frontmatter) return fail();
      const lines = frontmatter.split(/\r?\n/u);
      const keys = new Set<string>();
      let activeKey: string | undefined;
      let name: string | undefined;
      for (const line of lines) {
        if (!line.trim() || line.startsWith("#")) continue;
        const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u);
        if (field) {
          const key = field[1];
          const value = field[2] ?? "";
          if (!key) return fail();
          if (
            !SAFE_SKILL_FRONTMATTER_KEYS.has(key) ||
            keys.has(key) ||
            value.startsWith("&") ||
            value.startsWith("*") ||
            value.startsWith("!")
          ) {
            return fail();
          }
          keys.add(key);
          activeKey = key;
          if (key === "name") {
            const match = value.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*)$/u);
            if (!match) return fail();
            name = match[1];
          }
          continue;
        }
        // Only a simple sequence is needed to represent allowed-tools. Block
        // dynamic YAML constructs and unknown indentation rather than trying to
        // partially emulate the CLI's YAML parser.
        if (
          activeKey !== "allowed-tools" ||
          !/^\s+-\s+[^\s#][^\r\n]*$/u.test(line) ||
          /[&*!][A-Za-z0-9_-]/u.test(line)
        ) {
          return fail();
        }
      }
      if (
        !name ||
        (expectedName !== undefined && name !== expectedName) ||
        !keys.has("description")
      )
        return fail();

      const body = text.slice(text.indexOf("\n---", 4) + 4);
      // Claude Skills can run shell snippets during rendering with `!`code``.
      // That happens outside the normal tool permission path, so such content
      // is not eligible for this bridge.
      if (/!`/u.test(body)) return fail();
      return name;
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return fail();
  }
};

const findClaudeSkillDefinitions = (
  root: string,
  budget: ClaudeManagedSkillScanBudget
): string[] => {
  const skillsDirectory = path.join(root, "skills");
  try {
    const directoryInfo = fs.lstatSync(skillsDirectory);
    if (
      directoryInfo.isSymbolicLink() ||
      !directoryInfo.isDirectory() ||
      fs.realpathSync(skillsDirectory) !== skillsDirectory
    ) {
      return fail();
    }
    const candidates: string[] = [];
    const directory = fs.opendirSync(skillsDirectory);
    const entries: fs.Dirent[] = [];
    try {
      while (true) {
        const entry = directory.readSync();
        if (!entry) break;
        if (entries.length >= MAX_SKILL_DIRECTORIES) return fail();
        entries.push(entry);
      }
    } finally {
      directory.closeSync();
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) return fail();
      const skillDirectory = path.join(skillsDirectory, entry.name);
      if (fs.realpathSync(skillDirectory) !== skillDirectory) return fail();
      const skillFilePath = path.join(skillDirectory, "SKILL.md");
      if (!fs.existsSync(skillFilePath)) continue;
      const name = readClaudeSkillDefinition(skillFilePath, undefined, budget);
      candidates.push(name);
    }
    if (new Set(candidates).size !== candidates.length) return fail();
    return candidates;
  } catch {
    return fail();
  }
};

/**
 * Validate the complete Skill-visible root once. Catalog discovery may share
 * one byte budget across roots so a large command list cannot multiply reads.
 */
export const scanClaudeManagedSkillRoot = (input: {
  providerKind: "plugin" | "claude_root";
  providerPath: string;
  budget?: ClaudeManagedSkillScanBudget;
}): ClaudeManagedSkillRootInventory => {
  const { providerKind, providerPath } = input;
  const budget = input.budget ?? { remainingBytes: MAX_SKILL_ROOT_SCAN_BYTES };
  if (
    !Number.isSafeInteger(budget.remainingBytes) ||
    budget.remainingBytes < 0
  ) {
    return fail();
  }
  let pluginRoot: string;
  try {
    pluginRoot = fs.realpathSync(providerPath);
    if (
      pluginRoot !== path.resolve(providerPath) ||
      !fs.statSync(pluginRoot).isDirectory()
    ) {
      return fail();
    }
  } catch {
    return fail();
  }

  let namespace: string;
  if (providerKind === "plugin") {
    const manifest = readPluginManifest(pluginRoot);
    if (
      typeof manifest.name !== "string" ||
      !PLUGIN_NAME_PATTERN.test(manifest.name)
    )
      return fail();
    namespace = manifest.name;
  } else {
    namespace = path.basename(pluginRoot);
    if (
      namespace !== ".claude" &&
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(namespace)
    ) {
      return fail();
    }
  }

  const forbiddenEntries = new Set(FORBIDDEN_PLUGIN_ENTRIES);
  // The registered native config root commonly contains settings files. They
  // remain excluded by `settingSources: []`; a plugin root does not get this
  // exception because its full contents are loaded as a plugin definition.
  if (providerKind === "plugin") {
    forbiddenEntries.add("settings.json");
    forbiddenEntries.add("settings.local.json");
  }
  for (const entry of forbiddenEntries) {
    const entryPath = path.join(pluginRoot, entry);
    try {
      fs.lstatSync(entryPath);
      return fail();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail();
    }
  }

  return {
    providerPath: pluginRoot,
    namespace,
    skillNames: findClaudeSkillDefinitions(pluginRoot, budget)
  };
};

const validatePluginSkill = (
  selection: ClaudeManagedPluginSkillSelection
): string => {
  if (
    !selection ||
    typeof selection.name !== "string" ||
    (selection.providerKind !== "plugin" &&
      selection.providerKind !== "claude_root") ||
    typeof selection.providerPath !== "string" ||
    !path.isAbsolute(selection.providerPath) ||
    CONTROL_CHARACTERS.test(selection.name)
  ) {
    return fail();
  }

  const separator = selection.name.indexOf(":");
  if (
    separator <= 0 ||
    separator !== selection.name.lastIndexOf(":") ||
    separator === selection.name.length - 1
  ) {
    return fail();
  }
  const expectedPluginName = selection.name.slice(0, separator);
  const expectedSkillName = selection.name.slice(separator + 1);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(expectedSkillName) ||
    expectedSkillName === "." ||
    expectedSkillName === ".."
  ) {
    return fail();
  }
  if (
    selection.providerKind === "plugin"
      ? !PLUGIN_NAME_PATTERN.test(expectedPluginName)
      : expectedPluginName !== ".claude" &&
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(expectedPluginName)
  ) {
    return fail();
  }

  const root = scanClaudeManagedSkillRoot({
    providerKind: selection.providerKind,
    providerPath: selection.providerPath
  });
  if (
    root.namespace !== expectedPluginName ||
    !root.skillNames.includes(expectedSkillName)
  ) {
    return fail();
  }
  return root.providerPath;
};

/**
 * Turn a private, freshly revalidated plugin-Skill selection into the narrow
 * Claude SDK options that work with filesystem settings disabled.
 */
export const buildClaudeManagedPluginSkillOptions = (input: {
  selectedNames: readonly string[];
  selectedPluginSkills: readonly ClaudeManagedPluginSkillSelection[];
}): ClaudeManagedPluginSkillOptions => {
  const { selectedNames, selectedPluginSkills } = input;
  if (
    selectedNames.length === 0 ||
    selectedPluginSkills.length !== selectedNames.length ||
    new Set(selectedNames).size !== selectedNames.length
  ) {
    return fail();
  }

  const selectionsByName = new Map<string, ClaudeManagedPluginSkillSelection>();
  for (const selection of selectedPluginSkills) {
    if (selectionsByName.has(selection.name)) return fail();
    selectionsByName.set(selection.name, selection);
  }
  if (selectedNames.some((name) => !selectionsByName.has(name))) return fail();

  const pluginRootByName = new Map<string, string>();
  for (const name of selectedNames) {
    const selection = selectionsByName.get(name);
    if (!selection) return fail();
    pluginRootByName.set(name, validatePluginSkill(selection));
  }

  const pluginPaths = [...new Set(pluginRootByName.values())];
  return {
    plugins: pluginPaths.map((pluginPath) => ({
      type: "local" as const,
      path: pluginPath,
      skipMcpDiscovery: true
    })),
    skills: [...selectedNames],
    // A selected Skill does not need to launch a subagent. Keeping these
    // orchestrators unavailable avoids inheriting additional agent definitions
    // or allowing a child session to escape the host's approval callback.
    disallowedTools: ["Agent", "Task"],
    settings: {
      disableAllHooks: true,
      permissions: { ask: ["*"] }
    }
  };
};

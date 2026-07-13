import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROMPT_OVERRIDE_DIR_ENV = "KOED_PROMPT_DIR";

export const promptFileNames = {
  "mcp-server-instructions": "mcp-server-instructions.md",
  "memory-answer-tool-description": "memory-answer-tool-description.md",
  "memory-answer-worker": "memory-answer-worker.md",
  "session-title": "session-title.md",
  "lcm-summary-leaf": "lcm-summary-leaf.md",
  "lcm-summary-rollup": "lcm-summary-rollup.md",
  "lcm-summary-partial": "lcm-summary-partial.md",
  "lcm-summary-reduce": "lcm-summary-reduce.md",
  "app-server-memory-answer-base": "app-server/memory-answer-base.md",
  "app-server-memory-answer-developer": "app-server/memory-answer-developer.md",
  "app-server-worker-developer": "app-server/worker-developer.md",
  "app-server-lcm-summary-base": "app-server/lcm-summary-base.md",
  "app-server-session-title-base": "app-server/session-title-base.md",
  "app-server-eval-base": "app-server/eval-base.md",
  "eval-lcm-summary-semantic-judge": "evals/lcm-summary-semantic-judge.md"
} as const;

export type PromptId = keyof typeof promptFileNames;

export const requiredPromptPlaceholders = {
  "mcp-server-instructions": [],
  "memory-answer-tool-description": [],
  "memory-answer-worker": [
    "search_domain",
    "required_json_schema",
    "question",
    "retrieval_scope",
    "default_search_domain",
    "optional_defaults",
    "limit",
    "max_searches",
    "max_expansions",
    "initial_evidence_section"
  ],
  "session-title": [
    "session_id",
    "external_session_id",
    "current_title",
    "project",
    "title_event_count",
    "conversation_excerpts"
  ],
  "lcm-summary-leaf": [],
  "lcm-summary-rollup": [],
  "lcm-summary-partial": [],
  "lcm-summary-reduce": [],
  "app-server-memory-answer-base": [],
  "app-server-memory-answer-developer": [],
  "app-server-worker-developer": [],
  "app-server-lcm-summary-base": [],
  "app-server-session-title-base": [],
  "app-server-eval-base": [],
  "eval-lcm-summary-semantic-judge": [
    "threshold",
    "required_json_shape",
    "benchmark_input_json"
  ]
} as const satisfies Record<PromptId, readonly string[]>;

export interface LoadedPrompt {
  id: PromptId;
  version: string;
  body: string;
  sourcePath: string;
  overridden: boolean;
}

export interface RenderedPrompt extends LoadedPrompt {
  text: string;
}

export interface PromptLoadOptions {
  env?: NodeJS.ProcessEnv;
}

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const placeholderPattern = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

const parseFrontmatter = (
  filePath: string,
  raw: string
): { metadata: Record<string, string>; body: string } => {
  const match = raw.match(frontmatterPattern);
  if (!match) {
    throw new Error(`Prompt file ${filePath} is missing frontmatter`);
  }
  const frontmatter = match[1] ?? "";

  const metadata = Object.fromEntries(
    frontmatter
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(":");
        if (separator === -1) {
          throw new Error(
            `Prompt file ${filePath} has invalid frontmatter line: ${line}`
          );
        }
        return [
          line.slice(0, separator).trim(),
          line.slice(separator + 1).trim()
        ];
      })
  );

  return {
    metadata,
    body: raw.slice(match[0].length).trimEnd()
  };
};

const ancestorsFrom = (start: string): string[] => {
  const ancestors: string[] = [];
  let current = path.resolve(start);
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return ancestors;
    }
    current = parent;
  }
};

const packageNameAt = (directory: string): string | undefined => {
  const packagePath = path.join(directory, "package.json");
  if (!fs.existsSync(packagePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
      name?: unknown;
    };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
};

const findBundledPromptDirectory = (): string => {
  const packagedDirectory = path.join(moduleDirectory, "prompts");
  if (
    fs.existsSync(packagedDirectory) &&
    fs.statSync(packagedDirectory).isDirectory()
  ) {
    return packagedDirectory;
  }

  const roots = new Set<string>([
    ...ancestorsFrom(process.cwd()),
    ...ancestorsFrom(moduleDirectory)
  ]);

  for (const directory of roots) {
    const promptsDirectory = path.join(directory, "prompts");
    if (
      fs.existsSync(promptsDirectory) &&
      fs.statSync(promptsDirectory).isDirectory() &&
      packageNameAt(directory) === "koed"
    ) {
      return promptsDirectory;
    }
  }

  throw new Error(
    "Unable to locate bundled Koed prompts directory from current process"
  );
};

const filesystemErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

const resolveOverrideDirectory = (configuredDirectory: string): string => {
  const overrideDirectory = path.resolve(configuredDirectory);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(overrideDirectory);
  } catch (error) {
    if (filesystemErrorCode(error) === "ENOENT") {
      throw new Error(
        `Configured ${PROMPT_OVERRIDE_DIR_ENV} directory does not exist: ${overrideDirectory}`,
        { cause: error }
      );
    }
    throw new Error(
      `Configured ${PROMPT_OVERRIDE_DIR_ENV} directory cannot be accessed: ${overrideDirectory}`,
      { cause: error }
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `Configured ${PROMPT_OVERRIDE_DIR_ENV} path is not a directory: ${overrideDirectory}`
    );
  }
  try {
    fs.accessSync(overrideDirectory, fs.constants.R_OK);
    fs.readdirSync(overrideDirectory);
  } catch (error) {
    throw new Error(
      `Configured ${PROMPT_OVERRIDE_DIR_ENV} directory is not readable: ${overrideDirectory}`,
      { cause: error }
    );
  }
  return overrideDirectory;
};

const resolvePromptPath = (
  id: PromptId,
  env: NodeJS.ProcessEnv
): { filePath: string; overridden: boolean } => {
  const relativePath = promptFileNames[id];
  const configuredOverrideDirectory = env[PROMPT_OVERRIDE_DIR_ENV]?.trim();
  if (configuredOverrideDirectory) {
    const overrideDirectory = resolveOverrideDirectory(
      configuredOverrideDirectory
    );
    const overridePath = path.resolve(overrideDirectory, relativePath);
    let stats: fs.Stats | undefined;
    try {
      stats = fs.statSync(overridePath);
    } catch (error) {
      if (filesystemErrorCode(error) !== "ENOENT") {
        throw new Error(
          `Override prompt file cannot be accessed: ${overridePath}`,
          { cause: error }
        );
      }
    }
    if (stats) {
      if (!stats.isFile()) {
        throw new Error(`Override prompt path is not a file: ${overridePath}`);
      }
      try {
        fs.accessSync(overridePath, fs.constants.R_OK);
      } catch (error) {
        throw new Error(
          `Override prompt file is not readable: ${overridePath}`,
          {
            cause: error
          }
        );
      }
      return { filePath: overridePath, overridden: true };
    }
  }

  const bundledPath = path.join(findBundledPromptDirectory(), relativePath);
  if (!fs.existsSync(bundledPath)) {
    throw new Error(`Bundled prompt file not found: ${bundledPath}`);
  }
  return { filePath: bundledPath, overridden: false };
};

export const loadPrompt = (
  id: PromptId,
  options: PromptLoadOptions = {}
): LoadedPrompt => {
  const { filePath, overridden } = resolvePromptPath(
    id,
    options.env ?? process.env
  );
  const { metadata, body } = parseFrontmatter(
    filePath,
    fs.readFileSync(filePath, "utf8")
  );

  if (metadata.id !== id) {
    throw new Error(
      `Prompt file ${filePath} declares id ${metadata.id ?? "<missing>"} but ${id} was requested`
    );
  }
  if (!metadata.version) {
    throw new Error(`Prompt file ${filePath} is missing version frontmatter`);
  }
  if (!body.trim()) {
    throw new Error(`Prompt file ${filePath} is empty`);
  }
  const presentPlaceholders = new Set(
    [...body.matchAll(placeholderPattern)]
      .map((match) => match[1])
      .filter((name): name is string => typeof name === "string")
  );
  const missingRequiredPlaceholders = requiredPromptPlaceholders[id].filter(
    (name) => !presentPlaceholders.has(name)
  );
  if (missingRequiredPlaceholders.length > 0) {
    throw new Error(
      `Prompt file ${filePath} is missing required placeholders for ${id}: ${missingRequiredPlaceholders.join(", ")}`
    );
  }

  return {
    id,
    version: metadata.version,
    body,
    sourcePath: filePath,
    overridden
  };
};

export const renderPromptTemplate = (
  template: string,
  values: Record<string, string | number | boolean | null | undefined>
): string => {
  const placeholders = [...template.matchAll(placeholderPattern)];
  const missing = placeholders
    .map((match) => match[1])
    .filter(
      (name): name is string =>
        typeof name === "string" &&
        (values[name] === undefined || values[name] === null)
    );
  if (missing.length > 0) {
    throw new Error(
      `Prompt template has unresolved placeholders: ${[...new Set(missing)].join(", ")}`
    );
  }

  return template.replace(placeholderPattern, (_match, name: string) =>
    String(values[name])
  );
};

export const renderLoadedPrompt = (
  prompt: LoadedPrompt,
  values: Record<string, string | number | boolean | null | undefined>
): RenderedPrompt => ({
  ...prompt,
  text: renderPromptTemplate(prompt.body, values)
});

export const renderPromptWithMetadata = (
  id: PromptId,
  values: Record<string, string | number | boolean | null | undefined>,
  options: PromptLoadOptions = {}
): RenderedPrompt => renderLoadedPrompt(loadPrompt(id, options), values);

export const renderPrompt = (
  id: PromptId,
  values: Record<string, string | number | boolean | null | undefined>,
  options: PromptLoadOptions = {}
): string => renderPromptWithMetadata(id, values, options).text;

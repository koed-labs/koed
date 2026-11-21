import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Parser for Koed environment files. `strict` is the grammar every Koed
 * process uses for a file selected with `KOED_ENV_PATH`, so the supervisor and
 * its services read the same values from the same file.
 */
export interface ParseEnvFileOptions {
  strict?: boolean;
  source?: string;
}

export const parseEnvFile = (
  content: string,
  options: ParseEnvFileOptions = {}
): Record<string, string> => {
  const values: Record<string, string> = {};
  const fail = (lineNumber: number, reason: string): never => {
    throw new Error(
      `${options.source ?? "Environment file"}:${lineNumber}: ${reason}`
    );
  };
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals <= 0) {
      if (options.strict) fail(index + 1, "expected KEY=VALUE");
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    const quoted = value.startsWith('"') || value.startsWith("'");
    if (quoted && options.strict) {
      const quote = value[0];
      let closingQuote = -1;
      for (let position = 1; position < value.length; position += 1) {
        if (quote === '"' && value[position] === "\\") {
          position += 1;
        } else if (value[position] === quote) {
          closingQuote = position;
          break;
        }
      }
      if (closingQuote < 0) {
        fail(index + 1, `unterminated quoted value for ${key}`);
      }
      const trailing = value.slice(closingQuote + 1).trim();
      if (trailing && !trailing.startsWith("#")) {
        fail(index + 1, `unexpected text after quoted value for ${key}`);
      }
      value = value.slice(1, closingQuote);
    } else if (quoted) {
      if (value.length < 2 || value.at(-1) !== value[0]) {
        // Keep legacy parsing unchanged for implicitly discovered source env.
      } else {
        value = value.slice(1, -1);
      }
    }
    if (options.strict && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      fail(index + 1, `invalid environment variable name ${key}`);
    }
    values[key] = value;
  }
  return values;
};

/** Supervisor-only credentials that services must never load from a file. */
const supervisorOnlyKeys = new Set(["PRIVACY_RUNTIME_CONTROL_TOKEN"]);

/**
 * Applies the file selected by `KOED_ENV_PATH` to `environment` with the strict
 * grammar. Process values take precedence and supervisor-only credentials are
 * skipped. Returns false when no file is selected, so the caller can keep its
 * legacy app-local `.env` handling.
 */
export const loadExplicitServiceEnvFile = (
  environment: NodeJS.ProcessEnv
): boolean => {
  const selectedPath = environment.KOED_ENV_PATH?.trim();
  if (!selectedPath) {
    return false;
  }
  const path = resolve(selectedPath);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error("Explicit KOED_ENV_PATH could not be read", {
      cause: error
    });
  }
  const values = parseEnvFile(content, {
    strict: true,
    source: path
  });
  for (const [key, value] of Object.entries(values)) {
    if (!supervisorOnlyKeys.has(key) && environment[key] === undefined) {
      environment[key] = value;
    }
  }
  return true;
};

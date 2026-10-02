import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const readTools = new Set(["read", "glob", "grep", "ls", "find"]);
const inside = (root: string, target: string) => {
  const path = relative(root, target);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
};

/** Keep provider file inspection within the exact managed PR checkout. */
export async function pullRequestReadToolAllowed(
  checkout: string,
  toolName: string,
  input: Record<string, unknown>
): Promise<boolean> {
  if (!readTools.has(toolName.toLowerCase())) return false;
  try {
    const root = await realpath(checkout);
    for (const field of ["path", "file_path", "directory", "cwd"]) {
      const value = input[field];
      if (value === undefined) continue;
      if (
        typeof value !== "string" ||
        value.includes("\0") ||
        value.startsWith("~")
      )
        return false;
      const candidate = resolve(root, value);
      if (!inside(root, candidate) && !inside(resolve(checkout), candidate))
        return false;
      // Existing targets must also stay inside after following symlinks.
      if (!inside(root, await realpath(candidate))) return false;
    }
    // Glob/find include patterns are paths; grep's pattern is ordinary text.
    for (const field of toolName.toLowerCase() === "grep"
      ? ["glob"]
      : ["pattern", "glob"]) {
      const value = input[field];
      if (value === undefined) continue;
      if (
        typeof value !== "string" ||
        value.includes("\0") ||
        isAbsolute(value) ||
        value.startsWith("~") ||
        value.split(/[\\/]/).includes("..")
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

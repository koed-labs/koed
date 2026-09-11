/** Lexical native-path identity usable in both Electron and the renderer. */
export const normalizedLocalPath = (
  value: string | null | undefined
): string | null => {
  if (!value) return null;
  const windows = /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]/.test(value);
  let path = windows ? value.replace(/\\/g, "/").toLowerCase() : value;
  if (!path.startsWith("/") && !/^[a-z]:\//.test(path)) return null;
  const prefix = path.startsWith("//")
    ? (path.match(/^\/\/[^/]+\/[^/]+\/?/)?.[0] ?? "//")
    : path.startsWith("/")
      ? "/"
      : path.slice(0, 3);
  path = path.slice(prefix.length);
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return (prefix.endsWith("/") ? prefix : `${prefix}/`) + parts.join("/");
};

/** Returns a descendant's relative suffix; siblings and the root itself do not match. */
export const localPathDescendant = (
  root: string,
  candidate: string | null | undefined
): string | null => {
  const parent = normalizedLocalPath(root);
  const child = normalizedLocalPath(candidate);
  if (!parent || !child) return null;
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(prefix) && child.length > prefix.length
    ? child.slice(prefix.length)
    : null;
};

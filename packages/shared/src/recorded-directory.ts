/** Normalize recorded absolute paths without consulting the receiving filesystem. */
export const normalizeRecordedProjectDirectory = (
  value: unknown
): string | null => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 8192 ||
    value.includes("\0")
  )
    return null;
  const segments = (parts: string[]) => {
    const result: string[] = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") result.pop();
      else result.push(part);
    }
    return result;
  };
  if (value.startsWith("/")) return `/${segments(value.split("/")).join("/")}`;
  if (/^[a-z]:[\\/]/i.test(value)) {
    const tail = segments(value.slice(3).split(/[\\/]/)).join("\\");
    return `${value.slice(0, 2)}\\${tail}`;
  }
  const unc = /^\\\\([^\\/]+)[\\/]([^\\/]+)(?:[\\/]([\s\S]*))?$/.exec(value);
  if (!unc) return null;
  const tail = segments((unc[3] ?? "").split(/[\\/]/)).join("\\");
  return `\\\\${unc[1]}\\${unc[2]}\\${tail}`;
};

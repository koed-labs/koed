export type ModelProgress = {
  completedBytes: number | null;
  totalBytes: number | null;
  phase: "downloading" | "verifying" | "complete";
};

const bytes = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

/** Read only bounded, explicitly tagged progress records from CLI stderr. */
export function modelProgressReader(
  onProgress: (value: ModelProgress) => void
) {
  let pending = "";
  return (chunk: Buffer | string) => {
    pending += String(chunk);
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.startsWith("KOED_MODEL_PROGRESS ") || line.length > 4096)
        continue;
      try {
        const value = JSON.parse(line.slice("KOED_MODEL_PROGRESS ".length));
        if (
          value &&
          bytes(value.completedBytes) &&
          bytes(value.totalBytes) &&
          ["downloading", "verifying", "complete"].includes(value.phase)
        )
          onProgress(value);
      } catch {
        // Diagnostic output must never interrupt installation.
      }
    }
    if (pending.length > 4096) pending = "";
  };
}

import { readSync } from "node:fs";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import { runApplicationSecretProvider } from "./application-secret-provider.js";

const readSecretStdin = (): string | null => {
  const maximum = 2_000_000;
  const buffer = Buffer.allocUnsafe(maximum + 1);
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const count = readSync(0, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maximum) return null;
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    buffer.fill(0);
  }
};

export const runSecretProviderCommand = async (
  operation: "get" | "put" | "delete",
  reference: string,
  dependencies: KoedServerCliDependencies
): Promise<number> => {
  const stdout = dependencies.stdout ?? process.stdout;
  try {
    const value = operation === "put" ? readSecretStdin() : undefined;
    if (operation === "put" && value === null) return 1;
    const result = await runApplicationSecretProvider(
      operation,
      reference,
      value ?? undefined,
      process.env
    );
    if (!result.ok) return 1;
    if (operation === "get" && result.value !== null)
      stdout.write(result.value);
    return 0;
  } catch {
    return 1;
  }
};

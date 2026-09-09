import { spawn } from "node:child_process";

const maximumSecretBytes = 2_000_000;

const providerArgs = (environment: NodeJS.ProcessEnv): string[] => {
  const raw = environment.PDS_SECRET_PROVIDER_COMMAND_ARGS_JSON;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.length > 8 ||
      parsed.some((value) => typeof value !== "string" || value.length > 4096)
    ) {
      return [];
    }
    return parsed as string[];
  } catch {
    return [];
  }
};

const providerEnvironment = (
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => ({
  PATH: environment.PATH,
  HOME: environment.HOME,
  USER: environment.USER,
  LANG: environment.LANG,
  LC_ALL: environment.LC_ALL,
  ELECTRON_RUN_AS_NODE:
    environment.PDS_SECRET_PROVIDER?.trim() === "desktop_bridge"
      ? "1"
      : environment.ELECTRON_RUN_AS_NODE,
  PDS_DESKTOP_SECRET_BRIDGE_SOCKET:
    environment.PDS_DESKTOP_SECRET_BRIDGE_SOCKET,
  PDS_DESKTOP_SECRET_BRIDGE_TOKEN: environment.PDS_DESKTOP_SECRET_BRIDGE_TOKEN
});

export const resolveCommandSecret = async (
  reference: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<string | null> => {
  const provider = environment.PDS_SECRET_PROVIDER?.trim();
  const command = environment.PDS_SECRET_PROVIDER_COMMAND?.trim();
  if (
    (provider !== "headless" && provider !== "desktop_bridge") ||
    !command ||
    !/^[^\s\r\n\0]+$/.test(command) ||
    !/^[A-Za-z0-9:._-]{1,240}$/.test(reference)
  ) {
    return null;
  }
  return await new Promise<string | null>((resolvePromise) => {
    const child = spawn(
      command,
      [...providerArgs(environment), "get", reference],
      {
        env: providerEnvironment(environment),
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      }
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolvePromise(value);
    };
    const timeout = setTimeout(() => finish(null), 10_000);
    timeout.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maximumSecretBytes) return finish(null);
      chunks.push(chunk);
    });
    child.once("error", () => finish(null));
    child.once("close", (code) =>
      finish(code === 0 ? Buffer.concat(chunks).toString("utf8") : null)
    );
  });
};

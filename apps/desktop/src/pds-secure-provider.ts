import { spawn } from "node:child_process";
import {
  createPdsApplicationSecretStore,
  type PdsApplicationSecretStore
} from "@koed/shared";

export interface PdsDesktopSecretStore {
  readonly providerKind?: "application_managed" | "operator_managed";
  get(reference: string): Promise<string | null>;
  put(reference: string, value: string): Promise<void>;
  delete(reference: string): Promise<void>;
}

const maximumSecretBytes = 2_000_000;
const referencePattern = /^[A-Za-z0-9._-]{1,240}$/;

const providerArguments = (environment: NodeJS.ProcessEnv): string[] | null => {
  const raw = environment.PDS_SECRET_PROVIDER_COMMAND_ARGS_JSON;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) &&
      parsed.length <= 8 &&
      parsed.every(
        (value) => typeof value === "string" && value.length <= 4_096
      )
      ? (parsed as string[])
      : null;
  } catch {
    return null;
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
  KOED_HOME: environment.KOED_HOME,
  ELECTRON_RUN_AS_NODE: environment.ELECTRON_RUN_AS_NODE
});

const runOperatorProvider = (
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  operation: "get" | "put" | "delete",
  reference: string,
  value?: string
): Promise<{ ok: boolean; value: string | null }> =>
  new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args, operation, reference], {
        env: providerEnvironment(environment),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true
      });
    } catch {
      resolvePromise({ ok: false, value: null });
      return;
    }
    let output = "";
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ ok, value: operation === "get" && ok ? output : null });
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 10_000);
    if (!child.stdout || !child.stdin) {
      child.kill();
      finish(false);
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output, "utf8") > maximumSecretBytes) {
        child.kill();
        finish(false);
      }
    });
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin.end(value ?? "");
  });

const asDesktopStore = (
  store: PdsApplicationSecretStore
): PdsDesktopSecretStore => ({
  providerKind: "application_managed",
  get: async (reference) => store.get(reference),
  put: async (reference, value) => store.put(reference, value),
  delete: async (reference) => store.delete(reference)
});

const createOperatorManagedStore = (input: {
  environment: NodeJS.ProcessEnv;
}): PdsDesktopSecretStore | null => {
  const command = input.environment.PDS_SECRET_PROVIDER_COMMAND?.trim();
  const args = providerArguments(input.environment);
  if (
    input.environment.PDS_SECRET_PROVIDER?.trim() !== "headless" ||
    !command ||
    !/^[^\s\r\n\0]+$/.test(command) ||
    !args
  ) {
    return null;
  }
  return {
    providerKind: "operator_managed",
    async get(reference) {
      if (!referencePattern.test(reference)) return null;
      const result = await runOperatorProvider(
        command,
        args,
        input.environment,
        "get",
        reference
      );
      if (!result.ok) throw new Error("PDS secret provider failed.");
      return result.value;
    },
    async put(reference, value) {
      if (
        !referencePattern.test(reference) ||
        Buffer.byteLength(value, "utf8") > maximumSecretBytes
      ) {
        throw new Error("Invalid PDS secret.");
      }
      const result = await runOperatorProvider(
        command,
        args,
        input.environment,
        "put",
        reference,
        value
      );
      if (!result.ok) throw new Error("PDS secret provider rejected value.");
    },
    async delete(reference) {
      if (!referencePattern.test(reference)) {
        throw new Error("Invalid PDS secret reference.");
      }
      const result = await runOperatorProvider(
        command,
        args,
        input.environment,
        "delete",
        reference
      );
      if (!result.ok) throw new Error("PDS secret provider rejected delete.");
    }
  };
};

/**
 * Keeps trusted-main callers asynchronous while sharing filesystem custody
 * with standalone koed-server processes.
 */
export function createPdsDesktopSecretStore(input: {
  userDataPath: string;
  storeFilename?: string;
}): PdsDesktopSecretStore;
export function createPdsDesktopSecretStore(input: {
  userDataPath: string;
  storeFilename?: string;
  environment: NodeJS.ProcessEnv;
}): PdsDesktopSecretStore | null;
export function createPdsDesktopSecretStore(input: {
  userDataPath: string;
  storeFilename?: string;
  environment?: NodeJS.ProcessEnv;
}): PdsDesktopSecretStore | null {
  const environment = input.environment ?? {};
  if (
    environment.PDS_SECRET_PROVIDER?.trim() ||
    environment.PDS_SECRET_PROVIDER_COMMAND?.trim()
  ) {
    return createOperatorManagedStore({ environment });
  }
  return asDesktopStore(
    createPdsApplicationSecretStore({
      rootPath: input.userDataPath,
      ...(input.storeFilename
        ? {
            storeDirectory: ".",
            storeFilename: input.storeFilename,
            keyFilename: "koed-secret-store.key"
          }
        : {})
    })
  );
}

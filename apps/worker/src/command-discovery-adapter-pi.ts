import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  nodeCliInvocation,
  nodeCliProcessEnvironment
} from "@koed/shared";
import type {
  CommandDiscoveryAdapter,
  ManagedConversationSlashCommand
} from "./command-discovery-adapter.js";
import {
  createCommandDiscoveryAdapter,
  environmentForCommandDiscoveryInstance
} from "./command-discovery-adapter.js";

const MAX_COMMANDS = 128;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 512;

const allowedPiEnv = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "PI_CODING_AGENT_DIR",
  "SYSTEMROOT",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT"
];

const PI_RPC_MAX_RECORD_BYTES = 4 * 1024 * 1024;

type PiCommandsResponse = {
  id?: string;
  type?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: {
    commands?: Array<Record<string, unknown>>;
  };
};

const piRpcEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    allowedPiEnv.flatMap(
      (name) => (env[name] ? [[name, env[name]]] : [])
    )
  );

const WINDOWS_PI_SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);

const resolvePiNodeExecutablePath = (
  candidate: string,
  platform = process.platform
): string => {
  if (
    platform !== "win32" ||
    !WINDOWS_PI_SHIM_EXTENSIONS.has(
      path.extname(candidate).toLowerCase()
    )
  )
    return candidate;
  const entry = path.join(
    path.dirname(candidate),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js"
  );
  try {
    if (fs.statSync(entry).isFile()) return fs.realpathSync(entry);
  } catch {
    /* fall through */
  }
  throw new Error(
    `Pi launcher ${candidate} cannot be executed safely. Install Pi through npm with a verifiable package entry.`
  );
};

const resolvePiExecutable = (env: NodeJS.ProcessEnv = process.env): string => {
  const configured = env.KOED_PI_EXECUTABLE?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new Error("KOED_PI_EXECUTABLE must be an absolute path.");
  }
  const candidate =
    configured ?? executableOnPath(env);
  if (!candidate)
    throw new Error(
      "Pi was not found. Install and authenticate Pi, or set KOED_PI_EXECUTABLE to its absolute path."
    );
  const canonical = fs.realpathSync(
    resolvePiNodeExecutablePath(candidate)
  );
  if (!fs.statSync(canonical).isFile())
    throw new Error(
      `Pi executable is not a file: ${canonical}`
    );
  if (process.platform !== "win32")
    fs.accessSync(canonical, fs.constants.X_OK);
  return canonical;
};

const executableOnPath = (
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string | undefined => {
  const names =
    platform === "win32" ? ["pi.exe", "pi.cmd", "pi"] : ["pi"];
  const delimiter =
    platform === "win32" ? ";" : path.delimiter;
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        if (fs.statSync(candidate).isFile())
          return fs.realpathSync(candidate);
      } catch {
        /* continue */
      }
    }
  }
  return undefined;
};

const terminateProcessTree = (
  child: ChildProcessWithoutNullStreams
): void => {
  if (!child.pid) return;
  try {
    if (process.platform === "win32")
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore"
      });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

const validName = (value: string): string | null => {
  const name = value.trim().replaceAll("\\", "/");
  if (
    !name ||
    name.length > MAX_NAME_LENGTH ||
    name.startsWith("/") ||
    name
      .split("/")
      .some(
        (part) => !part || part === "." || part === ".."
      ) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(name)
  ) {
    return null;
  }
  return name;
};

const commandFromRaw = (
  raw: Record<string, unknown>,
  scope: "global" | "project"
): ManagedConversationSlashCommand | null => {
  if (!raw || typeof raw !== "object") return null;
  const name = validName(typeof raw.name === "string" ? raw.name : "");
  if (!name) return null;
  const description =
    typeof raw.description === "string"
      ? raw.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
      : "";
  const sourceType =
    typeof raw.source === "string" ? raw.source : "prompt";
  const sourceInfo =
    raw.sourceInfo && typeof raw.sourceInfo === "object"
      ? (raw.sourceInfo as Record<string, unknown>)
      : {};
  const rawScope =
    (typeof sourceInfo.scope === "string"
      ? sourceInfo.scope
      : "project") === "user"
      ? "global"
      : "project";
  const sourceKind =
    sourceType === "extension"
      ? "provider"
      : sourceType === "skill"
        ? scope === "global"
          ? "global-file"
          : "project-file"
        : scope === "global"
          ? "global-file"
          : "project-file";
  return {
    name,
    description,
    kind: sourceType === "skill" ? "skill" : "command",
    scope,
    source: sourceKind,
    verification: "unverified"
  };
};

const discoverFromRpc = (
  environment: NodeJS.ProcessEnv,
  projectRoot?: string
): Promise<ManagedConversationSlashCommand[]> => {
  let child: ChildProcessWithoutNullStreams;
  let fatalError: Error | null = null;
  const workerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "koed-pi-discovery-")
  );

  const cleanup = (): void => {
    if (child) {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      terminateProcessTree(child);
    }
    try {
      fs.rmSync(workerRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  return (async (): Promise<
    ManagedConversationSlashCommand[]
  > => {
    let executable: string;
    try {
      executable = resolvePiExecutable(environment);
    } catch {
      return [];
    }

    const args = [
      "--mode",
      "rpc",
      "--no-session",
      "--no-builtin-tools",
      "--no-themes",
      "--no-context-files",
      "--no-extensions"
    ];
    const invocation = nodeCliInvocation(executable, args);
    child = spawn(invocation.command, invocation.args, {
      cwd: workerRoot,
      env: nodeCliProcessEnvironment(
        invocation,
        piRpcEnvironment(environment),
        environment
      ),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stderr.resume();

    const stdinError = (error: Error): void => {
      if (!fatalError) fail(error);
    };
    child.stdin.once("error", stdinError);

    let stdout = Buffer.alloc(0);
    let aggregateBytes = 0;
    const pending = new Map<
      string,
      {
        resolve: (
          r: Record<string, unknown>[]
        ) => void;
        reject: (e: Error) => void;
        timer: NodeJS.Timeout;
      }
    >();

    const fail = (error: Error): void => {
      if (fatalError) return;
      fatalError = error;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      pending.clear();
      cleanup();
    };

    try {
      const result: Record<string, unknown>[] =
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () =>
              fail(
                new Error(
                  "Pi command discovery timed out"
                )
              ),
            5_000
          );

          child.once("error", (error) => fail(error));
          child.once("exit", (code) => {
            if (!fatalError && pending.size > 0)
              fail(
                new Error(
                  `Pi command discovery exited with code ${code}`
                )
              );
          });

          child.stdout.on(
            "data",
            (chunk: Buffer) => {
              aggregateBytes += chunk.length;
              if (
                aggregateBytes > PI_RPC_MAX_RECORD_BYTES
              ) {
                fail(
                  new Error(
                    "Pi command discovery output exceeded 4 MiB"
                  )
                );
                return;
              }
              stdout = Buffer.concat([
                stdout,
                chunk
              ]);
              while (true) {
                const newline =
                  stdout.indexOf(0x0a);
                if (newline < 0) {
                  if (
                    stdout.length >
                    PI_RPC_MAX_RECORD_BYTES
                  )
                    fail(
                      new Error(
                        "Pi command discovery record exceeded 4 MiB"
                      )
                    );
                  break;
                }
                if (
                  newline > PI_RPC_MAX_RECORD_BYTES
                ) {
                  fail(
                    new Error(
                      "Pi command discovery record exceeded 4 MiB"
                    )
                  );
                  return;
                }
                const record = stdout.subarray(
                  0,
                  newline
                );
                stdout = stdout.subarray(
                  newline + 1
                );
                if (record.length === 0) continue;
                let response: PiCommandsResponse;
                try {
                  response = JSON.parse(
                    record.toString("utf8")
                  ) as PiCommandsResponse;
                } catch {
                  fail(
                    new Error(
                      "Pi command discovery emitted malformed JSONL"
                    )
                  );
                  return;
                }
                if (
                  response.type !== "response" ||
                  typeof response.id !== "string"
                )
                  continue;
                const request =
                  pending.get(response.id);
                if (!request) continue;
                pending.delete(response.id);
                clearTimeout(request.timer);
                if (
                  response.success === true &&
                  Array.isArray(
                    response.data?.commands
                  )
                ) {
                  resolve(
                    response.data.commands
                  );
                } else {
                  reject(
                    new Error(
                      `Pi command discovery failed: ${response.error ?? "unknown"}`
                    )
                  );
                }
              }
            }
          );

          const id = randomUUID();
          pending.set(id, {
            resolve: resolve as (
              r: Record<string, unknown>[]
            ) => void,
            reject,
            timer: timeout
          });
          child.stdin.write(
            `${JSON.stringify({
              id,
              type: "get_commands"
            })}\n`
          );
        });

      return result
        .slice(0, MAX_COMMANDS)
        .map((raw) =>
          commandFromRaw(raw, "global")
        )
        .filter(
          (
            c
          ): c is ManagedConversationSlashCommand =>
            c !== null
        )
        .filter(
          (command) =>
            command.name.length > 0 &&
            !command.name.includes("/")
        );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(
          "timed out"
        )
      ) {
        return [];
      }
      return [];
    } finally {
      cleanup();
    }
  })();
};

export const createPiCommandDiscoveryAdapter = (
  baseEnvironment: NodeJS.ProcessEnv = process.env
): CommandDiscoveryAdapter => ({
  async discoverCommands(args) {
    const environment =
      environmentForCommandDiscoveryInstance(
        "pi",
        args.aiClientInstanceId,
        baseEnvironment
      );
    if (!environment) return [];

    const [globalCommands] = await Promise.all([
      discoverFromRpc(environment, args.projectRoot)
    ]);

    if (args.projectRoot) {
      const projectAdapter =
        createCommandDiscoveryAdapter(
          "pi",
          environment
        );
      const projectCommands = await projectAdapter
        .discoverCommands({
          aiClientInstanceId: args.aiClientInstanceId,
          projectRoot: args.projectRoot
        })
        .then((commands) =>
          commands.filter(
            (command) =>
              command.scope === "project" &&
              command.source ===
                "project-file"
          )
        );
      // Project overrides global by kind:name.
      const merged = new Map<
        string,
        ManagedConversationSlashCommand
      >();
      for (const cmd of globalCommands) {
        merged.set(
          `${cmd.kind}:${cmd.name.toLowerCase()}`,
          cmd
        );
      }
      for (const cmd of projectCommands) {
        merged.set(
          `${cmd.kind}:${cmd.name.toLowerCase()}`,
          cmd
        );
      }
      return [...merged.values()].slice(
        0,
        MAX_COMMANDS
      );
    }

    return globalCommands;
  }
});

import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { SourceControlCredential } from "./provider-drivers.js";

const execFileAsync = promisify(execFile);
const withGitCredential = async <T>(
  credential: SourceControlCredential,
  operation: (environment: NodeJS.ProcessEnv) => Promise<T>
): Promise<T> => {
  const directory = await mkdtemp(resolve(tmpdir(), "koed-git-askpass-"));
  const windows = process.platform === "win32";
  const helper = resolve(directory, windows ? "askpass.cmd" : "askpass.sh");
  const contents = windows
    ? "@echo off\r\nset prompt=%~1\r\necho %prompt% | findstr /I username >nul && (echo %KOED_GIT_USERNAME%) || (echo %KOED_GIT_TOKEN%)\r\n"
    : '#!/bin/sh\ncase "$1" in *[Uu]sername*) printf "%s\\n" "$KOED_GIT_USERNAME" ;; *) printf "%s\\n" "$KOED_GIT_TOKEN" ;; esac\n';
  await writeFile(helper, contents, { mode: 0o700 });
  if (!windows) await chmod(helper, 0o700);
  try {
    return await operation({
      GIT_ASKPASS: helper,
      GIT_ASKPASS_REQUIRE: "force",
      KOED_GIT_USERNAME:
        credential.scheme === "basic" ? credential.username : "x-access-token",
      KOED_GIT_TOKEN: credential.token
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** Credentials are available only inside a fresh Git directory with trusted config. */
export const withAuthenticatedGitRepository = async <T>(
  input: {
    credential: SourceControlCredential;
    commonDirectory: string;
    objectFormat: "sha1" | "sha256";
  },
  operation: (run: (args: string[]) => Promise<string>) => Promise<T>
): Promise<T> => {
  const directory = await mkdtemp(resolve(tmpdir(), "koed-git-transport-"));
  const gitDirectory = resolve(directory, "transport.git");
  const template = resolve(directory, "template");
  const config = resolve(directory, "empty-config");
  try {
    await mkdir(template);
    await writeFile(config, "", { mode: 0o600 });
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      LANG: process.env.LANG,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: config,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "https",
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: template,
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "http.followRedirects",
      GIT_CONFIG_VALUE_2: "false",
      GIT_CONFIG_KEY_3: "protocol.allow",
      GIT_CONFIG_VALUE_3: "never"
    };
    await execFileAsync(
      "git",
      [
        "init",
        "--bare",
        `--object-format=${input.objectFormat}`,
        `--template=${template}`,
        gitDirectory
      ],
      {
        cwd: directory,
        env: environment,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024
      }
    );
    return await withGitCredential(
      input.credential,
      async (credentialEnvironment) => {
        const run = async (args: string[]): Promise<string> => {
          const result = await execFileAsync("git", args, {
            cwd: directory,
            env: {
              ...environment,
              ...credentialEnvironment,
              GIT_DIR: gitDirectory,
              GIT_OBJECT_DIRECTORY: resolve(input.commonDirectory, "objects")
            },
            encoding: "utf8",
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true
          });
          return result.stdout.trim();
        };
        return operation(run);
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

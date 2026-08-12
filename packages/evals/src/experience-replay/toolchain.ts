import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import {
  listCodexAppServerModels,
  type CodexAppServerModelOption
} from "@koed/mcp-server/runtime-contracts";

const execFileAsync = promisify(execFile);

export interface ExecutableAttestation {
  path: string;
  sha256: string;
  sizeBytes: number;
  versionOutput: string;
}

export const sha256File = async (filename: string): Promise<string> => {
  const digest = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(filename)
      .once("error", reject)
      .once("end", resolve)
      .on("data", (chunk) => digest.update(chunk));
  });
  return digest.digest("hex");
};

export const attestExecutable = async ({
  binary,
  versionArguments,
  expectedSha256,
  expectedVersion
}: {
  binary: string;
  versionArguments: readonly string[];
  expectedSha256: string;
  expectedVersion: string;
}): Promise<ExecutableAttestation> => {
  const metadata = await stat(binary);
  if (!metadata.isFile())
    throw new Error(`Executable is not a regular file: ${binary}`);
  const sha256 = await sha256File(binary);
  if (sha256 !== expectedSha256)
    throw new Error(`Executable digest mismatch: ${binary}`);
  const { stdout, stderr } = await execFileAsync(
    binary,
    [...versionArguments],
    {
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    }
  );
  const versionOutput = `${stdout}${stderr}`.trim();
  if (!versionOutput.includes(expectedVersion)) {
    throw new Error(`Executable version mismatch: expected ${expectedVersion}`);
  }
  return {
    path: binary,
    sha256,
    sizeBytes: metadata.size,
    versionOutput
  };
};

export const attestExactModels = async ({
  binary,
  requiredModelIds,
  environment,
  cwd,
  listModels = listCodexAppServerModels
}: {
  binary: string;
  requiredModelIds: readonly string[];
  environment: NodeJS.ProcessEnv;
  cwd: string;
  listModels?: typeof listCodexAppServerModels;
}): Promise<readonly CodexAppServerModelOption[]> => {
  const bootstrapModel = requiredModelIds[0];
  if (!bootstrapModel) throw new Error("At least one exact model is required");
  const models = await listModels({
    appServerBinary: binary,
    model: bootstrapModel,
    cwd,
    env: environment,
    includeHidden: true
  });
  const byId = new Map(models.map((model) => [model.id, model]));
  for (const id of new Set(requiredModelIds)) {
    if (!byId.has(id))
      throw new Error(`Codex model/list did not expose exact model ${id}`);
  }
  return Object.freeze(models.map((model) => Object.freeze({ ...model })));
};

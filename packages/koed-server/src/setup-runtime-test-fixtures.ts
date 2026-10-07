import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KoedServerPaths } from "./paths.js";
import { signedComponentFixture } from "./component-test-fixtures.js";
import { stageComponent, stageGeneration } from "./component-store.js";
import { activateGeneration } from "./generation-lifecycle.js";
import { resolveKoedRuntimeOwner } from "./app-runtime.js";

const baseRuntimeFiles = [
  "api/dist/index.js",
  "worker/dist/index.js",
  "embedding-service/dist/index.js",
  "mcp-server/dist/index.js",
  "mcp-server/dist/cli.js",
  "mcp-server/dist/local-runtime-cli.js",
  "mcp-server/dist/capture-hook.js",
  "mcp-server/dist/prompts/codex-global-agent-guidance.md",
  "node_modules/@koed/db/dist/index.js",
  "node_modules/@koed/db/dist/connection.js",
  "node_modules/@koed/db/dist/user-api-token-repository.js",
  "node_modules/@koed/db/drizzle/meta/_journal.json"
] as const;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const piPackageSource = resolve(
  repoRoot,
  "packages/mcp-server/integrations/pi"
);
const collectPiFiles = (directory: string, relative = ""): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? collectPiFiles(resolve(directory, entry.name), child)
      : [`node_modules/@koed/mcp-server/integrations/pi/${child}`];
  });
const runtimeFiles = [...baseRuntimeFiles, ...collectPiFiles(piPackageSource)];

export async function stageSignedSetupRuntime(
  paths: KoedServerPaths,
  productVersion: string,
  trustFixture: (
    fixture: Awaited<ReturnType<typeof signedComponentFixture>>
  ) => void
) {
  mkdirSync(paths.componentsDir, { recursive: true, mode: 0o700 });
  const piContents = Object.fromEntries(
    collectPiFiles(piPackageSource).map((path) => [
      path,
      readFileSync(
        resolve(
          piPackageSource,
          path.replace("node_modules/@koed/mcp-server/integrations/pi/", "")
        )
      )
    ])
  );
  const contents = {
    ...piContents,
    "mcp-server/dist/prompts/codex-global-agent-guidance.md": readFileSync(
      resolve(repoRoot, "prompts/codex-global-agent-guidance.md")
    )
  };
  const fixture = await signedComponentFixture(
    {
      productVersion,
      component: "base",
      requiredFiles: runtimeFiles
    },
    runtimeFiles.map((path) => ({ path })),
    {},
    true,
    contents
  );
  trustFixture(fixture);
  const writeMetadata = (name: string, content: Buffer) => {
    const path = resolve(paths.koedHome, name);
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  };
  const base = await stageComponent(
    paths,
    {
      kind: "offline",
      archivePath: fixture.input.archivePath,
      manifestPath: writeMetadata(
        "fixture-manifest.json",
        fixture.input.manifestBytes
      ),
      signaturePath: writeMetadata(
        "fixture-signature.json",
        Buffer.from(JSON.stringify(fixture.input.signature))
      )
    },
    {
      expectedComponent: "base",
      expectedVersion: productVersion,
      target: {
        platform: fixture.input.runtime.platform,
        architecture: fixture.input.runtime.architecture
      },
      runtime: fixture.input.runtime
    }
  );
  const generation = await stageGeneration(paths, {
    base,
    owner: resolveKoedRuntimeOwner()
  });
  await activateGeneration(paths, generation.id, resolveKoedRuntimeOwner());
  return fixture;
}

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

// Use the configured installation's public SDK and its native RPC server.
// The explicit cwd override preserves exact transferred source bytes while
// binding tools and project discovery to the receiving execution workspace.
async function main() {
  const config = JSON.parse(process.argv[2]);
  const sdk = await import(pathToFileURL(config.sdkEntry).href);
  const cwd = fs.realpathSync(config.cwd);
  const agentDir = sdk.getAgentDir();
  const sessionManager = config.forkSourcePath
    ? sdk.SessionManager.forkFrom(
        config.forkSourcePath,
        cwd,
        config.sessionDirectory,
        { id: config.sessionId }
      )
    : config.resumeSessionPath
      ? sdk.SessionManager.open(
          config.resumeSessionPath,
          config.sessionDirectory,
          cwd
        )
      : sdk.SessionManager.create(cwd, config.sessionDirectory, {
          id: config.sessionId
        });
  const createRuntime = async ({
    cwd: targetCwd,
    sessionManager: manager,
    sessionStartEvent
  }) => {
    if (fs.realpathSync(targetCwd) !== cwd)
      throw new Error("Managed Pi workspace changed.");
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntimeSignal: globalThis.AbortSignal.timeout(15_000),
      resourceLoaderOptions: {
        noExtensions: true,
        additionalExtensionPaths: [
          fileURLToPath(new URL("./extensions/koed.mjs", import.meta.url)),
          fileURLToPath(new URL("./managed-permissions.mjs", import.meta.url))
        ]
      }
    });
    if (services.resourceLoader.getExtensions().errors.length)
      throw new Error("Managed Pi extensions could not load.");
    const models = await services.modelRuntime.getAvailable();
    const model = models.find(
      (candidate) => `${candidate.provider}/${candidate.id}` === config.model
    );
    if (!model) throw new Error("Managed Pi model is unavailable.");
    const created = await sdk.createAgentSessionFromServices({
      services,
      sessionManager: manager,
      sessionStartEvent,
      model,
      ...(config.reasoningEffort
        ? { thinkingLevel: config.reasoningEffort }
        : {})
    });
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager
  });
  await sdk.runRpcMode(runtime);
}

main().catch(() => {
  process.stderr.write("Managed Pi runtime initialization failed.\n");
  process.exitCode = 1;
});

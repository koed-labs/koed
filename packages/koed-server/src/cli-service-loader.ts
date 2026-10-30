import type { KoedServerCliDependencies } from "./cli-contract.js";

export const reportMissingCliService = (
  dependencies: KoedServerCliDependencies,
  json: boolean | undefined
): number => {
  const error =
    "Koed service runtime is not provisioned. Install the manifest-pinned base component from a trusted offline archive pair, then run `koed doctor`.";
  if (json)
    (dependencies.stdout ?? process.stdout).write(
      `${JSON.stringify({ ok: false, error, action: "components install --component base" }, null, 2)}\n`
    );
  else (dependencies.stderr ?? process.stderr).write(`${error}\n`);
  return 1;
};

// Only module-loading failures become provisioning guidance. Operation errors
// retain their command-specific handling and must not be masked as import errors.
export const withCliService = async <T>(
  load: () => Promise<T>,
  run: (service: T) => Promise<number>,
  dependencies: KoedServerCliDependencies,
  json: boolean | undefined
): Promise<number> => {
  let service: T;
  try {
    service = await load();
  } catch {
    return reportMissingCliService(dependencies, json);
  }
  return run(service);
};

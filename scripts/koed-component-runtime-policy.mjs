export const validatedElectronRuntime = Object.freeze({
  version: "39.8.10",
  nodeVersion: "22.22.1",
  modulesAbi: "140",
  napiVersion: 10
});

export const assertElectronVersionMatchesLock = ({
  lockVersion,
  installedVersion
}) => {
  if (!lockVersion || installedVersion !== lockVersion)
    throw new Error(
      `Installed Electron ${installedVersion ?? "(missing)"} does not match pnpm-lock.yaml ${lockVersion ?? "(missing)"}.`
    );
};

export const componentRuntimeDeclarations = ({
  nodeModulesAbi,
  electronIdentity
}) => {
  const runtimes = [
    {
      kind: "node",
      runtimeRange: ">=24 <25",
      nodeRange: ">=24 <25",
      modulesAbi: nodeModulesAbi
    }
  ];
  if (!electronIdentity) return runtimes;

  const expected = validatedElectronRuntime;
  if (
    electronIdentity.version !== expected.version ||
    electronIdentity.nodeVersion !== expected.nodeVersion ||
    electronIdentity.modulesAbi !== expected.modulesAbi ||
    electronIdentity.napiVersion !== expected.napiVersion
  ) {
    throw new Error(
      `Electron compatibility is not validated for ${JSON.stringify(electronIdentity)}; review and test the pinned runtime before updating the compatibility policy.`
    );
  }
  return [
    ...runtimes,
    {
      kind: "electron",
      runtimeRange: `=${expected.version}`,
      nodeRange: `=${expected.nodeVersion}`,
      modulesAbi: expected.modulesAbi,
      minimumNapi: expected.napiVersion
    }
  ];
};

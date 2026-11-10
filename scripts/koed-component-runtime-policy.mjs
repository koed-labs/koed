export const validatedElectronRuntime = Object.freeze({
  version: "45.2.3",
  nodeVersion: "24.22.2",
  modulesAbi: "150",
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

export const componentRuntimeDeclarations = ({ electronIdentity }) => {
  const runtimes = [
    {
      kind: "node",
      runtimeRange: ">=24 <27",
      nodeRange: ">=24 <27",
      minimumNapi: 10
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

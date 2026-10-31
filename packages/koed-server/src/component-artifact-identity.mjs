export const componentArchiveName = ({
  component,
  productVersion,
  target,
  variant
}) =>
  `koed-${component}-${productVersion}-${target.platform}-${target.architecture}${variant === undefined ? "" : `-${variant}`}.tar.gz`;

export const validateComponentVariantIdentity = (value) => {
  if (value.schemaVersion === 1 && !Object.hasOwn(value, "variant")) return;
  if (
    value.schemaVersion === 2 &&
    value.component === "privacy" &&
    value.target?.platform === "linux" &&
    value.target.architecture === "x64" &&
    ["cpu", "cuda"].includes(value.variant)
  )
    return;
  throw new Error(
    "Unsupported component variant identity; update to a compatible control plane."
  );
};

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const isKoedReleaseVersion = (value) =>
  typeof value === "string" && semverPattern.test(value);

export const assertKoedReleaseVersion = (
  value,
  source = "Koed release version"
) => {
  if (!isKoedReleaseVersion(value)) {
    throw new Error(
      `${source} must contain a valid SemVer version: ${JSON.stringify(value)}`
    );
  }
  return value;
};

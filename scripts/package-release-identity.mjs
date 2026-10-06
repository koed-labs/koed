import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const filesUnder = (root, directory = root) =>
  readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Package inventory cannot contain symlink: ${path}`);
      return entry.isDirectory() ? filesUnder(root, path) : [path];
    })
    .sort();

export const createPackageReleaseIdentity = ({
  packageRoot,
  tarball,
  version
}) => {
  const manifest = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8")
  );
  if (manifest.name !== "@koed-labs/server" || manifest.version !== version)
    throw new Error(
      "Public package name or version does not match release identity."
    );
  const inventory = createHash("sha256");
  for (const path of filesUnder(packageRoot)) {
    const relativePath = relative(packageRoot, path).split(sep).join("/");
    inventory.update(relativePath);
    inventory.update("\0");
    inventory.update(
      createHash("sha256").update(readFileSync(path)).digest("hex")
    );
    inventory.update("\0");
  }
  const tarballBytes = readFileSync(tarball);
  const stat = lstatSync(tarball);
  return {
    schemaVersion: 1,
    packageName: manifest.name,
    version,
    npm: {
      integrity: `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`,
      inventorySha256: inventory.digest("hex"),
      bytes: stat.size
    }
  };
};

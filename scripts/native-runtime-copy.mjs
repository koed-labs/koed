import { cpSync } from "node:fs";

export const copyNativeRuntimeSource = (source, destination) => {
  cpSync(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true
  });
};

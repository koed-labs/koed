import { renameSync } from "node:fs";

export const renameAtomically = (source: string, destination: string): void =>
  renameSync(source, destination);

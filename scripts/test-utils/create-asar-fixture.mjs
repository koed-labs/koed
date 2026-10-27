import { finished } from "node:stream/promises";

export const createAsarFixture = async (createPackage, source, destination) => {
  // asar 3 returns the ending stream before its final bytes reach disk.
  const output = await createPackage(source, destination);
  if (output && typeof output.once === "function") await finished(output);
};

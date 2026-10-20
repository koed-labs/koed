export const citationAliasBatches = (tags: string): string[][] => {
  const aliases = tags
    .split("\u0000")
    .filter((value) => /^r[0-9a-f]{32}c[1-9][0-9]*$/.test(value));
  const batches: string[][] = [];
  for (let index = 0; index < aliases.length; index += 64)
    batches.push(aliases.slice(index, index + 64));
  return batches;
};

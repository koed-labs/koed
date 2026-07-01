export const lcmSummaryOptionValue = (
  args: string[],
  name: string
): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
};

export const parseLcmSummaryRunsOption = (
  value: string | undefined
): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== value || parsed < 1) {
    throw new Error("--runs must be an integer greater than or equal to 1");
  }
  return parsed;
};

export const parseLcmSummaryThresholdOption = (
  value: string | undefined,
  name = "--threshold"
): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim() !== value || value.length === 0) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }
  return parsed;
};

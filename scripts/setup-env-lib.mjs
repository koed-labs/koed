export const retainedCompatibilityKeys = new Set([
  "API_DATA_ENCRYPTION_KEY",
  "API_TOKEN_PEPPER",
  "EMBEDDING_SERVICE_TOKEN",
  "GITHUB_TOKEN",
  "MEMORY_API_TOKEN"
]);

export const splitEnvLine = (line) => {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  return match ? { key: match[1], value: match[2] } : null;
};

export const parseEnv = (contents) => {
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const entry = splitEnvLine(line);
    if (entry) {
      values.set(entry.key, entry.value);
    }
  }
  return values;
};

export const shouldGenerateValue = (generatedValues, key, value) =>
  generatedValues.has(key) &&
  (value === undefined ||
    value.trim() === "" ||
    value.trim().startsWith("replace_with_generated"));

const hasUsableCompatibilityValue = (value) =>
  value.trim() !== "" && !value.trim().startsWith("replace_with_");

export const valueForKey = ({
  key,
  currentValues,
  exampleValues,
  generatedValues
}) => {
  const current = currentValues.get(key);
  if (
    current !== undefined &&
    ((retainedCompatibilityKeys.has(key) &&
      hasUsableCompatibilityValue(current)) ||
      !shouldGenerateValue(generatedValues, key, current))
  ) {
    return current;
  }

  const generated = generatedValues.get(key);
  if (generated !== undefined) {
    return generated;
  }
  return exampleValues.get(key) ?? "";
};

export const renderSetupEnv = ({ example, existing, generatedValues }) => {
  const currentValues = parseEnv(existing);
  const exampleValues = parseEnv(example);

  return example
    .split(/\r?\n/)
    .map((line) => {
      const entry = splitEnvLine(line);
      return entry
        ? `${entry.key}=${valueForKey({
            key: entry.key,
            currentValues,
            exampleValues,
            generatedValues
          })}`
        : line;
    })
    .join("\n");
};

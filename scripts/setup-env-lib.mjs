export const retainedCompatibilityKeys = new Set([
  "API_DATA_ENCRYPTION_KEY",
  "API_TOKEN_PEPPER",
  "API_COLLABORATION_LOCAL_BROKER_SECRET",
  "API_COLLABORATION_REALTIME_CURSOR_SECRET",
  "EMBEDDING_SERVICE_TOKEN",
  "PRIVACY_SERVICE_TOKEN",
  "PRIVACY_RUNTIME_CONTROL_TOKEN",
  "MEMORY_API_TOKEN",
  "OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY",
  "API_TEAM_MEMORY_DATA_ENCRYPTION_KEY"
]);

// Existing .env files are normally preserved by setup. Migrate only the old
// documented accelerator defaults and leave intentional Operator overrides
// untouched.
export const legacyEmbeddingAccelerationDefaults = new Map([
  ["EMBEDDING_LLAMA_N_CTX", { from: "32768", to: "8192" }],
  ["EMBEDDING_LLAMA_N_UBATCH", { from: "8192", to: "512" }],
  ["EMBEDDING_RERANKER_LLAMA_N_UBATCH", { from: "8192", to: "512" }]
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

export const migrateLegacyEmbeddingAccelerationDefaults = (contents) =>
  contents
    .split(/\r?\n/)
    .map((line) => {
      const entry = splitEnvLine(line);
      const migration = entry
        ? legacyEmbeddingAccelerationDefaults.get(entry.key)
        : undefined;
      if (migration === undefined || entry.value.trim() !== migration.from) {
        return line;
      }
      return `${entry.key}=${migration.to}`;
    })
    .join("\n");

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

  const renderedExample = example
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
  const retainedOverrides = [...currentValues.entries()].filter(
    ([key]) => !exampleValues.has(key)
  );
  if (retainedOverrides.length === 0) {
    return renderedExample;
  }
  return [
    renderedExample.trimEnd(),
    "",
    "# Operator overrides retained from the existing environment.",
    ...retainedOverrides.map(([key, value]) => `${key}=${value}`),
    ""
  ].join("\n");
};

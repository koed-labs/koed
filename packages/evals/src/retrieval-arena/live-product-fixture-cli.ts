import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedLiveProductFixture } from "./live-product-fixture.js";

const values = (name: string): string[] => {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .filter((value) => value.startsWith(prefix))
    .flatMap((value) => value.slice(prefix.length).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
};

const required = (name: string, environmentName: string): string => {
  const value = values(name)[0] ?? process.env[environmentName]?.trim();
  if (!value)
    throw new Error(
      `Missing --${name}=... (or ${environmentName}) for live fixture command`
    );
  return value;
};

const main = async (): Promise<void> => {
  const caseIds = values("case");
  if (!caseIds.length)
    throw new Error(
      "Pass at least one --case=<id>; unsupported representation/authority cases fail closed"
    );
  const outputPath = resolve(
    required("output", "KOED_EVAL_PRODUCT_STATE_MANIFEST")
  );
  await seedLiveProductFixture({
    baseUrl: required("api-url", "KOED_EVAL_PRODUCT_API_URL"),
    authorization: required("authorization", "KOED_EVAL_PRODUCT_AUTHORIZATION"),
    databaseUrl: required("database-url", "KOED_EVAL_PRODUCT_DATABASE_URL"),
    outputPath,
    caseIds
  });
  process.stdout.write(`${outputPath}\n`);
};

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  });
}

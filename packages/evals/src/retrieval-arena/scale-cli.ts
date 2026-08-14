import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRetrievalScaleReport,
  generateRetrievalScaleLoad,
  retrievalScaleProfiles,
  retrievalScaleScopeAttestationSchema,
  scaleLoadIdentity,
  type RetrievalScaleProfile
} from "./scale-runner.js";
import {
  cleanupRetrievalScaleLoad,
  importRetrievalScaleLoad,
  observeRetrievalScaleScope,
  withScaleDatabase
} from "./scale-importer.js";

const value = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
};

const required = (name: string): string => {
  const found = value(name);
  if (!found) throw new Error(`--${name}=... is required`);
  return found;
};

const selectedProfile = (): RetrievalScaleProfile => {
  const id = required("profile") as RetrievalScaleProfile["id"];
  const profile = retrievalScaleProfiles[id];
  if (!profile)
    throw new Error(
      `unknown scale profile ${id}; expected ${Object.keys(retrievalScaleProfiles).join(" or ")}`
    );
  return profile;
};

const writeLoad = async (): Promise<void> => {
  const profile = selectedProfile();
  const seed = required("seed");
  const output = resolve(required("output"));
  await mkdir(dirname(output), { recursive: true });
  const stream = createWriteStream(output, { encoding: "utf8", flags: "wx" });
  try {
    for (const record of generateRetrievalScaleLoad(profile, seed)) {
      if (!stream.write(`${JSON.stringify(record)}\n`))
        await once(stream, "drain");
    }
    stream.end();
    await once(stream, "finish");
  } catch (error) {
    stream.destroy();
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({ output, profile: profile.id, seed, loadIdentity: scaleLoadIdentity(profile, seed), scope: profile.scope })}\n`
  );
};

const writeReport = async (): Promise<void> => {
  const profile = selectedProfile();
  const arenaReport: unknown = JSON.parse(
    await readFile(resolve(required("arena-report")), "utf8")
  );
  const scopeAttestation = retrievalScaleScopeAttestationSchema.parse(
    JSON.parse(await readFile(resolve(required("scope-attestation")), "utf8"))
  );
  const report = buildRetrievalScaleReport({
    profile,
    scopeAttestation,
    arenaReport
  });
  const output = resolve(required("output"));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  process.stdout.write(`${output}\n`);
};

const databaseOptions = () => {
  const expectedDatabase = required("expected-database");
  const expectedSchema = required("expected-schema");
  return {
    databaseUrl: required("database-url"),
    expectedDatabase,
    expectedSchema,
    databaseIdentity: `${expectedDatabase}:${expectedSchema}`
  };
};

const writeAttestation = async (
  output: string,
  attestation: unknown
): Promise<void> => {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(attestation, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  process.stdout.write(`${JSON.stringify({ output })}\n`);
};

const loadDatabase = async (): Promise<void> => {
  const profile = selectedProfile();
  const seed = required("seed");
  const database = databaseOptions();
  const output = resolve(required("attestation-output"));
  const attestation = await withScaleDatabase({
    ...database,
    operation: (db) =>
      importRetrievalScaleLoad({
        db,
        expectedDatabase: database.expectedDatabase,
        schema: database.expectedSchema,
        path: resolve(required("input")),
        profile,
        seed,
        runtimeIdentity: required("runtime-identity"),
        databaseIdentity: database.databaseIdentity
      })
  });
  await writeAttestation(output, attestation);
};

const attestDatabase = async (): Promise<void> => {
  const profile = selectedProfile();
  const seed = required("seed");
  const database = databaseOptions();
  const output = resolve(required("output"));
  const attestation = await withScaleDatabase({
    ...database,
    operation: (db) =>
      observeRetrievalScaleScope({
        db,
        schema: database.expectedSchema,
        profile,
        seed,
        runtimeIdentity: required("runtime-identity"),
        databaseIdentity: database.databaseIdentity
      })
  });
  await writeAttestation(output, attestation);
};

const cleanupDatabase = async (): Promise<void> => {
  const profile = selectedProfile();
  const seed = required("seed");
  const database = databaseOptions();
  await withScaleDatabase({
    ...database,
    operation: (db) =>
      cleanupRetrievalScaleLoad({
        db,
        expectedDatabase: database.expectedDatabase,
        schema: database.expectedSchema,
        profile,
        seed
      })
  });
  process.stdout.write(
    `${JSON.stringify({ cleaned: true, profile: profile.id, seed })}\n`
  );
};

const main = async (): Promise<void> => {
  const command = process.argv[2] === "--" ? process.argv[3] : process.argv[2];
  if (command === "generate-load") return writeLoad();
  if (command === "load") return loadDatabase();
  if (command === "attest") return attestDatabase();
  if (command === "cleanup") return cleanupDatabase();
  if (command === "report") return writeReport();
  throw new Error(
    "usage: scale-cli.js generate-load|load|attest|cleanup|report --profile=development-smoke|realistic-launch ..."
  );
};

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void main().catch((error) => {
    const secret = value("database-url");
    const message = error instanceof Error ? error.message : String(error);
    const redacted = (
      secret ? message.replaceAll(secret, "[REDACTED_DATABASE_URL]") : message
    ).replace(/postgres(?:ql)?:\/\/\S+/gi, "[REDACTED_DATABASE_URL]");
    process.stderr.write(`${redacted}\n`);
    process.exitCode = 1;
  });
}

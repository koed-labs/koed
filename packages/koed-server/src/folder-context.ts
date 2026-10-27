import {
  personalFolderRegistrySchema,
  readPersonalFolderDirectoryMarker,
  findPersonalFolderDirectory
} from "@koed/shared/personal-local-folders";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  normalizeRecordedProjectDirectory,
  personalFolderObservationSchema,
  type PersonalFolderObservation
} from "@koed/shared";
import { inspectDeviceIdentityStatus } from "./device-identity.js";
import { withProjectMetadataLock } from "./project-metadata-lock.js";
import type { KoedServerPaths } from "./paths.js";

/** Observe a live source directory only. Historical import must never call this. */
export const observeCaptureFolder = async (
  paths: KoedServerPaths,
  capturedPath: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<PersonalFolderObservation | undefined> => {
  const normalizedPath = normalizeRecordedProjectDirectory(capturedPath);
  if (!normalizedPath) return undefined;
  const device = await inspectDeviceIdentityStatus(paths, { environment });
  if (
    !device.remoteOperationsAllowed ||
    !device.deploymentId ||
    !device.deviceInstanceId
  )
    return undefined;
  let currentMarker: ReturnType<typeof readPersonalFolderDirectoryMarker>;
  try {
    currentMarker = readPersonalFolderDirectoryMarker(normalizedPath);
    if (!currentMarker) return undefined;
  } catch {
    return undefined;
  }
  const deploymentId = device.deploymentId;
  const deviceId = device.deviceInstanceId;
  const marker = currentMarker.marker;
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  const registryPath = join(paths.configDir, "folder-contexts.json");
  return withProjectMetadataLock(registryPath, () => {
    const registry = existsSync(registryPath)
      ? personalFolderRegistrySchema.parse(
          JSON.parse(readFileSync(registryPath, "utf8"))
        )
      : {
          version: 1 as const,
          profileId: randomUUID(),
          directories: [] as z.infer<
            typeof personalFolderRegistrySchema
          >["directories"]
        };
    let directory = findPersonalFolderDirectory(
      registry.directories,
      normalizedPath,
      deploymentId,
      deviceId,
      currentMarker
    );
    if (
      !directory &&
      currentMarker.marker === currentMarker.deviceMarker &&
      registry.directories.some(
        (entry) =>
          entry.deploymentId === deploymentId &&
          entry.deviceId === deviceId &&
          entry.normalizedPath === normalizedPath &&
          entry.marker.startsWith('["volume:')
      )
    )
      return undefined;
    let changed = false;
    if (!directory) {
      directory = {
        deploymentId,
        deviceId,
        normalizedPath,
        marker,
        folderId: randomUUID(),
        incarnationId: randomUUID()
      };
      registry.directories.push(directory);
      changed = true;
    } else if (directory.marker !== marker) {
      directory.marker = marker;
      changed = true;
    }
    if (changed) {
      const temporary = `${registryPath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx"
        });
        renameSync(temporary, registryPath);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    return personalFolderObservationSchema.parse({
      identity: {
        folderId: directory.folderId,
        originatingDeploymentId: deploymentId,
        originatingDeviceId: deviceId,
        originatingProfileId: registry.profileId,
        directoryIncarnationId: directory.incarnationId
      },
      normalizedPath,
      capturedPath,
      observedAt: new Date().toISOString()
    });
  });
};

const sourceFolderSchema = z
  .object({
    version: z.literal(1),
    sourceKind: z.enum(["codex", "claude-code", "pi"]),
    externalSessionId: z.string().min(1).max(1024),
    original: personalFolderObservationSchema.nullable(),
    latest: personalFolderObservationSchema.nullable().optional()
  })
  .strict();
type SourceFolderKey = Pick<
  z.infer<typeof sourceFolderSchema>,
  "sourceKind" | "externalSessionId"
>;
const sourceFolderPath = (paths: KoedServerPaths, key: SourceFolderKey) =>
  join(
    paths.dataDir,
    "source-folder-contexts",
    `${createHash("sha256")
      .update(JSON.stringify([key.sourceKind, key.externalSessionId]))
      .digest("hex")}.json`
  );

/** Missing source-time evidence is durable; a resume cannot fill it from today's disk. */
export const pinSourceFolderObservation = (
  paths: KoedServerPaths,
  key: SourceFolderKey,
  observation: PersonalFolderObservation | undefined,
  newConversation = true
): void => {
  const target = sourceFolderPath(paths, key);
  withProjectMetadataLock(target, () => {
    const prior = existsSync(target)
      ? sourceFolderSchema.parse(JSON.parse(readFileSync(target, "utf8")))
      : undefined;
    if (
      prior &&
      (prior.sourceKind !== key.sourceKind ||
        prior.externalSessionId !== key.externalSessionId)
    )
      throw new Error("Folder source identity conflicts");
    const record = sourceFolderSchema.parse({
      version: 1,
      sourceKind: key.sourceKind,
      externalSessionId: key.externalSessionId,
      original: prior
        ? prior.original
        : newConversation
          ? (observation ?? null)
          : null,
      latest: observation ?? null
    });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
        mode: 0o600,
        flag: "wx"
      });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  });
};

/** Reads recorded provenance only; safe for historical import on another filesystem. */
const readSourceFolderRecord = (
  paths: KoedServerPaths,
  key: SourceFolderKey
) => {
  const target = sourceFolderPath(paths, key);
  if (!existsSync(target)) return undefined;
  const record = sourceFolderSchema.parse(
    JSON.parse(readFileSync(target, "utf8"))
  );
  if (
    record.sourceKind !== key.sourceKind ||
    record.externalSessionId !== key.externalSessionId
  )
    throw new Error("Folder source identity conflicts");
  return record;
};

export const readSourceFolderObservation = (
  paths: KoedServerPaths,
  key: SourceFolderKey
) => readSourceFolderRecord(paths, key)?.original ?? undefined;
export const readCurrentSourceFolderObservation = (
  paths: KoedServerPaths,
  key: SourceFolderKey
) => readSourceFolderRecord(paths, key)?.latest ?? undefined;

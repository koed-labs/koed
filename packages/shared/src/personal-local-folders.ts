import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import { inspectDeviceIdentityAtKoedHome } from "./device-identity.js";
import {
  personalIdentifierSchema,
  personalFolderObservationSchema,
  type PersonalFolderObservation
} from "./personal-source-contract.js";

export const personalFolderRegistrySchema = z
  .object({
    version: z.literal(1),
    profileId: personalIdentifierSchema,
    directories: z.array(
      z
        .object({
          deploymentId: personalIdentifierSchema,
          deviceId: personalIdentifierSchema,
          normalizedPath: z.string(),
          marker: z.string(),
          folderId: personalIdentifierSchema,
          incarnationId: personalIdentifierSchema
        })
        .strict()
    )
  })
  .strict();

type DirectoryMarker = { marker: string; deviceMarker: string };
type RegistryDirectory = z.infer<
  typeof personalFolderRegistrySchema
>["directories"][number];

/** macOS device numbers describe a mount, not a durable volume identity. */
const macVolumeUuid = (path: string): string | undefined => {
  if (process.platform !== "darwin") return undefined;
  try {
    const options = {
      encoding: "utf8" as const,
      timeout: 2_000,
      maxBuffer: 256 * 1024,
      stdio: "pipe" as const
    };
    const filesystem = execFileSync("/bin/df", ["-P", path], options)
      .trim()
      .split("\n")
      .at(-1)
      ?.trim()
      .split(/\s+/)[0];
    if (!filesystem || !/^\/dev\/disk\d+(?:s\d+)*$/.test(filesystem))
      return undefined;
    const plist = execFileSync(
      "/usr/sbin/diskutil",
      ["info", "-plist", filesystem],
      options
    );
    const uuid =
      /<key>VolumeUUID<\/key>\s*<string>([0-9a-f-]+)<\/string>/i.exec(
        plist
      )?.[1];
    return uuid && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid)
      ? uuid.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
};

/** The per-read cache avoids repeated disk lookups without retaining a mount's
 * identity after the read. A remounted/replaced volume is checked again. */
export const readPersonalFolderDirectoryMarker = (
  path: string,
  volumes = new Map<bigint, string | undefined>()
): DirectoryMarker | undefined => {
  const directory = statSync(path, { bigint: true });
  if (
    !directory.isDirectory() ||
    directory.ino <= 0n ||
    directory.birthtimeNs <= 0n
  )
    return undefined;
  if (!volumes.has(directory.dev))
    volumes.set(directory.dev, macVolumeUuid(path));
  const volume = volumes.get(directory.dev);
  const lifetime = [directory.ino.toString(), directory.birthtimeNs.toString()];
  return {
    marker: JSON.stringify([
      volume ? `volume:${volume}` : directory.dev.toString(),
      ...lifetime
    ]),
    deviceMarker: JSON.stringify([directory.dev.toString(), ...lifetime])
  };
};

const numericMarkerSchema = z.tuple([
  z.string().regex(/^\d+$/),
  z.string().regex(/^[1-9]\d*$/),
  z.string().regex(/^[1-9]\d*$/)
]);

const sameDirectoryLifetime = (left: string, right: string): boolean => {
  try {
    const schema = z.tuple([z.string(), z.string(), z.string()]);
    const a = schema.parse(JSON.parse(left));
    const b = schema.parse(JSON.parse(right));
    return a[1] === b[1] && a[2] === b[2];
  } catch {
    return false;
  }
};

export const personalFolderDirectoryMarkerMatches = (
  recorded: string,
  current: DirectoryMarker
): boolean => {
  if (recorded === current.marker || recorded === current.deviceMarker)
    return true;
  // Existing registrations did not record a volume UUID. A native observation
  // can adopt them only at the same host-bound path with the same lifetime.
  if (current.marker === current.deviceMarker) return false;
  try {
    const previous = numericMarkerSchema.safeParse(JSON.parse(recorded));
    const live = numericMarkerSchema.parse(JSON.parse(current.deviceMarker));
    return (
      previous.success &&
      previous.data[1] === live[1] &&
      previous.data[2] === live[2]
    );
  } catch {
    return false;
  }
};

/** Preserve the current registration when older mount numbers left duplicate
 * records. This chooses a live capability; it never merges captured history. */
export const findPersonalFolderDirectory = (
  entries: readonly RegistryDirectory[],
  path: string,
  deploymentId: string,
  deviceId: string,
  marker: DirectoryMarker
): RegistryDirectory | undefined => {
  const candidates = entries
    .filter(
      (entry) =>
        entry.normalizedPath === path &&
        entry.deploymentId === deploymentId &&
        entry.deviceId === deviceId
    )
    .reverse();
  const volumeBound = candidates.filter(
    (entry) =>
      entry.marker.startsWith('["volume:') &&
      sameDirectoryLifetime(entry.marker, marker.deviceMarker)
  );
  // Once this lifetime has a volume binding, an older numeric registration
  // cannot bypass a mismatch or a failed volume lookup.
  if (volumeBound.length)
    return volumeBound.find((entry) => entry.marker === marker.marker);
  return (
    candidates.find((entry) => entry.marker === marker.marker) ??
    candidates.find((entry) => entry.marker === marker.deviceMarker) ??
    candidates.find((entry) =>
      personalFolderDirectoryMarkerMatches(entry.marker, marker)
    )
  );
};

/** Read current, host-bound native Folder registrations. Equal paths on another
 * device/profile or a replacement directory never confer execution capability. */
export const readAvailablePersonalFolders = (
  koedHome: string,
  environment: NodeJS.ProcessEnv = process.env
): PersonalFolderObservation[] => {
  const device = inspectDeviceIdentityAtKoedHome({ koedHome, environment });
  if (
    !device.remoteOperationsAllowed ||
    !device.deploymentId ||
    !device.deviceInstanceId
  )
    return [];
  let registry: z.infer<typeof personalFolderRegistrySchema>;
  try {
    registry = personalFolderRegistrySchema.parse(
      JSON.parse(
        readFileSync(
          resolve(koedHome, "config", "folder-contexts.json"),
          "utf8"
        )
      )
    );
  } catch {
    return [];
  }
  const volumes = new Map<bigint, string | undefined>();
  const paths = new Set(
    registry.directories
      .filter(
        (entry) =>
          entry.deploymentId === device.deploymentId &&
          entry.deviceId === device.deviceInstanceId
      )
      .map((entry) => entry.normalizedPath)
  );
  return [...paths].flatMap((path) => {
    try {
      const marker = readPersonalFolderDirectoryMarker(path, volumes);
      if (!marker) return [];
      const entry = findPersonalFolderDirectory(
        registry.directories,
        path,
        device.deploymentId!,
        device.deviceInstanceId!,
        marker
      );
      if (!entry) return [];
      return [
        personalFolderObservationSchema.parse({
          identity: {
            folderId: entry.folderId,
            originatingDeploymentId: entry.deploymentId,
            originatingDeviceId: entry.deviceId,
            originatingProfileId: registry.profileId,
            directoryIncarnationId: entry.incarnationId
          },
          normalizedPath: entry.normalizedPath,
          capturedPath: entry.normalizedPath,
          observedAt: new Date().toISOString()
        })
      ];
    } catch {
      return [];
    }
  });
};

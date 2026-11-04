import { z } from "zod";
import { productionNativeRuntimeCatalog } from "./native-runtime-catalog-data.mjs";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .refine((value) =>
    value.split(".").every((part) => Number.isSafeInteger(Number(part)))
  );
const corePin = z
  .object({
    recipeId: digest,
    runtimeVersion: version,
    url: z.string(),
    sha256: digest,
    archiveBytes: z.number().int().positive().max(50_000_000),
    expandedBytes: z.number().int().positive().max(100_000_000),
    manifestSha256: digest,
    target: z
      .object({
        platform: z.literal("linux"),
        architecture: z.literal("x64"),
        libc: z
          .object({
            family: z.literal("glibc"),
            minimumVersion: z.literal("2.35")
          })
          .strict()
      })
      .strict(),
    contracts: z
      .object({
        layout: z.literal(1),
        postgres: z.literal(1),
        embedding: z.literal(1)
      })
      .strict(),
    components: z
      .object({
        postgres: z
          .object({
            major: z.literal(17),
            version: z.string().regex(/^17\.\d+$/)
          })
          .strict(),
        pgvector: z.object({ version: z.literal("0.8.3") }).strict(),
        llamaCpp: z
          .object({
            version: z.string().regex(/^b\d+$/),
            revision: z.string().regex(/^[a-f0-9]{40}$/)
          })
          .strict()
      })
      .strict()
  })
  .strict()
  .refine(
    (pin) =>
      pin.url ===
      `https://github.com/koed-labs/koed/releases/download/native-core-${pin.recipeId}/koed-native-core-${pin.recipeId}-linux-x64.tar.gz`,
    "Native core URL does not identify the retained recipe release."
  );

export const compareNativeVersions = (left: string, right: string): number => {
  const a = version.parse(left).split(".").map(Number);
  const b = version.parse(right).split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
};

const catalog = z
  .object({
    schemaVersion: z.literal(1),
    minimumCoreVersion: version,
    core: corePin,
    // A CPU-only catalog is complete. CUDA authority stays absent until the
    // independent real-GPU qualification and publication gate is complete.
    cuda: z.null()
  })
  .strict()
  .refine(
    (value) =>
      compareNativeVersions(
        value.core.runtimeVersion,
        value.minimumCoreVersion
      ) >= 0,
    "Pinned native core is below the compiled minimum runtime version."
  );

export type NativeCorePin = z.infer<typeof corePin>;
export type NativeRuntimeCatalog = z.infer<typeof catalog>;

export const validateNativeRuntimeCatalog = (
  value: unknown
): NativeRuntimeCatalog => {
  const parsed = catalog.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `Invalid compiled native runtime catalog: ${parsed.error.message}`
    );
  return parsed.data;
};

export const getNativeRuntimeCatalog = (): NativeRuntimeCatalog => {
  if (productionNativeRuntimeCatalog === null)
    throw new Error(
      "This Control Plane has no reviewed native runtime pin. Use a trusted release with native runtime support."
    );
  return validateNativeRuntimeCatalog(productionNativeRuntimeCatalog);
};

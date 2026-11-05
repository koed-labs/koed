import { z } from "zod";
import { productionNativeRuntimeCatalog } from "./native-runtime-catalog-data.mjs";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .refine((value) =>
    value.split(".").every((part) => Number.isSafeInteger(Number(part)))
  );
const target = z
  .object({
    platform: z.literal("linux"),
    architecture: z.literal("x64"),
    libc: z
      .object({ family: z.literal("glibc"), minimumVersion: z.literal("2.35") })
      .strict()
  })
  .strict();
const llamaCpp = z
  .object({
    version: z.string().regex(/^b\d+$/),
    revision: z.string().regex(/^[a-f0-9]{40}$/)
  })
  .strict();
const contracts = z
  .object({ layout: z.literal(1), embedding: z.literal(1) })
  .strict();
const shared = {
  recipeId: digest,
  runtimeVersion: version,
  url: z.string(),
  sha256: digest,
  manifestSha256: digest,
  target
};
const size = (maximum: number) => z.number().int().positive().max(maximum);
const retainedUrl = (
  kind: "core" | "cuda",
  pin: { recipeId: string; url: string }
) => {
  const prefix = "https://github.com/koed-labs/koed/releases/download/";
  const [tag, archive, ...extra] = pin.url.slice(prefix.length).split("/");
  return (
    pin.url.startsWith(prefix) &&
    extra.length === 0 &&
    archive === `koed-native-${kind}-${pin.recipeId}-linux-x64.tar.gz` &&
    (tag === `native-${kind}-${pin.recipeId}` ||
      /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? ""))
  );
};
const corePin = z
  .object({
    ...shared,
    archiveBytes: size(50_000_000),
    expandedBytes: size(100_000_000),
    contracts: contracts.extend({ postgres: z.literal(1) }),
    components: z
      .object({
        postgres: z
          .object({
            major: z.literal(17),
            version: z.string().regex(/^17\.\d+$/)
          })
          .strict(),
        pgvector: z.object({ version: z.literal("0.8.3") }).strict(),
        llamaCpp
      })
      .strict()
  })
  .strict()
  .refine(
    (pin) => retainedUrl("core", pin),
    "Native core URL does not identify the retained recipe release."
  );
const cudaPin = z
  .object({
    ...shared,
    archiveBytes: size(750_000_000),
    expandedBytes: size(1_600_000_000),
    contracts,
    llamaCpp,
    cuda: z
      .object({
        toolkitVersion: z.literal("12.4"),
        minimumDriverLinux: z.literal("550.54.14"),
        architectures: z
          .array(
            z.union([
              z.literal(75),
              z.literal(80),
              z.literal(86),
              z.literal(89),
              z.literal(90)
            ])
          )
          .min(1)
          .max(5)
          .refine((values) => new Set(values).size === values.length)
      })
      .strict()
  })
  .strict()
  .refine(
    (pin) => retainedUrl("cuda", pin),
    "Native CUDA URL does not identify the retained recipe release."
  );

export type NativeCorePin = z.infer<typeof corePin>;
export type NativeCudaPin = z.infer<typeof cudaPin>;
export type NativePin = NativeCorePin | NativeCudaPin;
export const nativeKind = (pin: NativePin) =>
  "components" in pin ? "core" : "cuda";
export const compatibleCuda = (core: NativeCorePin, cuda: NativeCudaPin) =>
  core.components.llamaCpp.revision === cuda.llamaCpp.revision &&
  core.components.llamaCpp.version === cuda.llamaCpp.version &&
  core.contracts.layout === cuda.contracts.layout &&
  core.contracts.embedding === cuda.contracts.embedding;

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
    cuda: cudaPin.nullable()
  })
  .strict()
  .refine(
    (value) => !value.cuda || compatibleCuda(value.core, value.cuda),
    "Pinned CUDA add-on does not match the core revision and contracts."
  )
  .refine(
    (value) =>
      compareNativeVersions(
        value.core.runtimeVersion,
        value.minimumCoreVersion
      ) >= 0,
    "Pinned native core is below the compiled minimum runtime version."
  );

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

import { createHash, createHmac } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { z } from "zod";

export const privacyLabels = [
  "account_number",
  "private_address",
  "private_email",
  "private_person",
  "private_phone",
  "private_url",
  "private_date",
  "secret"
] as const;

export type PrivacyLabel = (typeof privacyLabels)[number];

export const privacyLabelSchema = z.enum(privacyLabels);

export const PRIVACY_CLASSIFICATION_CONTRACT_VERSION =
  "koed-privacy-classification-v1";
export const PRIVACY_REPLACEMENT_CONTRACT_VERSION =
  "koed-privacy-typed-placeholders-v1";
export const PRIVACY_CLASSIFICATION_REQUEST_FIELD_LIMIT = 128;
export const PRIVACY_CLASSIFICATION_AGGREGATE_FIELD_LIMIT = 2_048;

const PRIVACY_FINGERPRINT_KEY_DOMAIN = "koed:privacy-owner-fingerprint-key:v1";

/**
 * Derives a domain-separated cache-fingerprint key from the deployment's data
 * encryption root. The derived bytes are never persisted.
 */
export const derivePrivacyFingerprintKey = (
  apiDataEncryptionKey: string
): Uint8Array => {
  if (!apiDataEncryptionKey.trim()) {
    throw new TypeError("Privacy fingerprint root key is required");
  }
  return createHmac("sha256", apiDataEncryptionKey)
    .update(PRIVACY_FINGERPRINT_KEY_DOMAIN, "utf8")
    .digest();
};

export const privacyDetectedSpanSchema = z
  .object({
    label: privacyLabelSchema,
    startByte: z.number().int().nonnegative(),
    endByte: z.number().int().positive(),
    confidence: z.number().min(0).max(1).optional(),
    detectors: z
      .array(z.enum(["privacy_filter", "deterministic"]))
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length, {
        message: "Privacy span detectors must be distinct"
      })
  })
  .strict()
  .refine((span) => span.endByte > span.startByte, {
    message: "Privacy span endByte must be greater than startByte"
  });

export type PrivacyDetectedSpan = z.infer<typeof privacyDetectedSpanSchema>;

export const privacyClassificationFieldRequestSchema = z
  .object({
    path: z.string().min(1).max(512),
    text: z.string()
  })
  .strict();

export type PrivacyClassificationFieldRequest = z.infer<
  typeof privacyClassificationFieldRequestSchema
>;

export const privacyClassificationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    inputContractVersion: z.literal(PRIVACY_CLASSIFICATION_CONTRACT_VERSION),
    fields: z
      .array(privacyClassificationFieldRequestSchema)
      .min(1)
      .max(PRIVACY_CLASSIFICATION_REQUEST_FIELD_LIMIT)
  })
  .strict()
  .superRefine((request, context) => {
    const paths = new Set<string>();
    for (const [index, field] of request.fields.entries()) {
      if (paths.has(field.path)) {
        context.addIssue({
          code: "custom",
          path: ["fields", index, "path"],
          message: "Privacy field paths must be distinct"
        });
      }
      paths.add(field.path);
    }
  });

export type PrivacyClassificationRequest = z.infer<
  typeof privacyClassificationRequestSchema
>;

export const privacyClassifiedFieldSchema = z
  .object({
    path: z.string().min(1).max(512),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    inputByteLength: z.number().int().nonnegative(),
    maskedText: z.string(),
    spans: z.array(privacyDetectedSpanSchema),
    decodedTextMatchesInput: z.literal(true)
  })
  .strict();

export type PrivacyClassifiedField = z.infer<
  typeof privacyClassifiedFieldSchema
>;

export const privacyClassificationResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    inputContractVersion: z.literal(PRIVACY_CLASSIFICATION_CONTRACT_VERSION),
    classifier: z
      .object({
        classifierHash: z.string().regex(/^[a-f0-9]{64}$/),
        modelKey: z.string().min(1),
        modelRevision: z.string().min(1)
      })
      .strict(),
    fields: z
      .array(privacyClassifiedFieldSchema)
      .min(1)
      .max(PRIVACY_CLASSIFICATION_REQUEST_FIELD_LIMIT)
  })
  .strict()
  .superRefine((response, context) => {
    const paths = new Set<string>();
    for (const [index, field] of response.fields.entries()) {
      if (paths.has(field.path)) {
        context.addIssue({
          code: "custom",
          path: ["fields", index, "path"],
          message: "Classified privacy field paths must be distinct"
        });
      }
      paths.add(field.path);
    }
  });

export type PrivacyClassificationResponse = z.infer<
  typeof privacyClassificationResponseSchema
>;

export const privacyClassificationAggregateResponseSchema =
  privacyClassificationResponseSchema.safeExtend({
    fields: z
      .array(privacyClassifiedFieldSchema)
      .min(1)
      .max(PRIVACY_CLASSIFICATION_AGGREGATE_FIELD_LIMIT)
  });

export type PrivacyLabelPolicy = Record<PrivacyLabel, boolean>;

export const allPrivacyLabelsPolicy = (): PrivacyLabelPolicy =>
  Object.fromEntries(
    privacyLabels.map((label) => [label, true])
  ) as PrivacyLabelPolicy;

export const noPrivacyLabelsPolicy = (): PrivacyLabelPolicy =>
  Object.fromEntries(
    privacyLabels.map((label) => [label, false])
  ) as PrivacyLabelPolicy;

export const privacyLabelPolicySchema = z
  .object(
    Object.fromEntries(
      privacyLabels.map((label) => [label, z.boolean()])
    ) as Record<PrivacyLabel, z.ZodBoolean>
  )
  .strict();

export const resolveEffectivePrivacyPolicy = (
  ...policies: readonly PrivacyLabelPolicy[]
): PrivacyLabelPolicy => {
  const effective = noPrivacyLabelsPolicy();
  for (const label of privacyLabels) {
    effective[label] = policies.some((policy) => policy[label]);
  }
  return effective;
};

export const privacyContentPolicyHash = (input: {
  labels: PrivacyLabelPolicy;
  replacementContractVersion?: string;
}): string =>
  createHash("sha256")
    .update(
      canonicalize({
        labels: privacyLabelPolicySchema.parse(input.labels),
        replacementContractVersion:
          input.replacementContractVersion ??
          PRIVACY_REPLACEMENT_CONTRACT_VERSION
      })
    )
    .digest("hex");

const placeholderFor = (label: PrivacyLabel): string =>
  `[${label.toUpperCase()}]`;

const utf8Boundaries = (text: string): Set<number> => {
  const boundaries = new Set<number>([0]);
  let offset = 0;
  for (const value of text) {
    offset += Buffer.byteLength(value, "utf8");
    boundaries.add(offset);
  }
  return boundaries;
};

interface ActiveSpan {
  startByte: number;
  endByte: number;
  labels: Set<PrivacyLabel>;
}

export interface SanitizedPrivacyText {
  text: string;
  changed: boolean;
  appliedSpanCount: number;
  appliedLabels: PrivacyLabel[];
}

export const sanitizeTextWithPrivacySpans = (input: {
  text: string;
  spans: readonly PrivacyDetectedSpan[];
  policy: PrivacyLabelPolicy;
}): SanitizedPrivacyText => {
  const source = Buffer.from(input.text, "utf8");
  const boundaries = utf8Boundaries(input.text);
  const selected = input.spans
    .map((span) => privacyDetectedSpanSchema.parse(span))
    .filter((span) => input.policy[span.label])
    .sort(
      (left, right) =>
        left.startByte - right.startByte ||
        right.endByte - left.endByte ||
        left.label.localeCompare(right.label)
    );

  const active: ActiveSpan[] = [];
  for (const span of selected) {
    if (
      span.endByte > source.byteLength ||
      !boundaries.has(span.startByte) ||
      !boundaries.has(span.endByte)
    ) {
      throw new TypeError(
        "Privacy span does not align with UTF-8 input boundaries"
      );
    }
    const current = active.at(-1);
    if (current && span.startByte < current.endByte) {
      current.endByte = Math.max(current.endByte, span.endByte);
      current.labels.add(span.label);
      continue;
    }
    active.push({
      startByte: span.startByte,
      endByte: span.endByte,
      labels: new Set([span.label])
    });
  }

  if (active.length === 0) {
    return {
      text: input.text,
      changed: false,
      appliedSpanCount: 0,
      appliedLabels: []
    };
  }

  const chunks: Buffer[] = [];
  const appliedLabels = new Set<PrivacyLabel>();
  let cursor = 0;
  for (const span of active) {
    chunks.push(source.subarray(cursor, span.startByte));
    for (const label of span.labels) appliedLabels.add(label);
    const replacement =
      span.labels.size === 1
        ? placeholderFor([...span.labels][0]!)
        : "[PRIVATE_DATA]";
    chunks.push(Buffer.from(replacement, "utf8"));
    cursor = span.endByte;
  }
  chunks.push(source.subarray(cursor));

  return {
    text: Buffer.concat(chunks).toString("utf8"),
    changed: true,
    appliedSpanCount: active.length,
    appliedLabels: [...appliedLabels].sort()
  };
};

export const privacyClassifierHash = (input: {
  version: number;
  modelKey: string;
  modelRevision: string;
  artifactSha256: string;
  tokenizerSha256: string;
  decoderSha256: string;
  calibrationSha256: string;
  deterministicDetectorVersion: string;
  inputContractVersion?: string;
}): string =>
  createHash("sha256")
    .update(
      canonicalize({
        ...input,
        inputContractVersion:
          input.inputContractVersion ?? PRIVACY_CLASSIFICATION_CONTRACT_VERSION
      })
    )
    .digest("hex");

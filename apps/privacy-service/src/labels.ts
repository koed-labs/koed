import { privacyLabels, type PrivacyLabel } from "@koed/shared";

export const PRIVACY_LABELS = privacyLabels;
export type { PrivacyLabel } from "@koed/shared";

// This order is the immutable id2label order in the pinned model config.
const MODEL_LABELS: readonly PrivacyLabel[] = [
  "account_number",
  "private_address",
  "private_date",
  "private_email",
  "private_person",
  "private_phone",
  "private_url",
  "secret"
] as const;
export type BoundaryTag = "B" | "I" | "E" | "S";
export type TokenLabel = "O" | `${BoundaryTag}-${PrivacyLabel}`;

export const TOKEN_LABELS: readonly TokenLabel[] = [
  "O",
  ...MODEL_LABELS.flatMap((label) =>
    (["B", "I", "E", "S"] as const).map((tag) => `${tag}-${label}` as const)
  )
];

export const placeholderFor = (label: PrivacyLabel): string =>
  `[${label.toUpperCase()}]`;

export const parseTokenLabel = (
  label: TokenLabel
): { tag: BoundaryTag; label: PrivacyLabel } | null => {
  if (label === "O") return null;
  const separator = label.indexOf("-");
  return {
    tag: label.slice(0, separator) as BoundaryTag,
    label: label.slice(separator + 1) as PrivacyLabel
  };
};

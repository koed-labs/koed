import type {
  ArtifactTarget,
  ComponentId,
  ComponentVariant
} from "./component-contract.js";
export function componentArchiveName(identity: {
  component: ComponentId;
  productVersion: string;
  target: ArtifactTarget;
  variant?: ComponentVariant;
}): string;
export function validateComponentVariantIdentity(value: unknown): void;

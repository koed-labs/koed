import {
  readDesktopLocalCredentialAuthorization,
  verifyDesktopLocalCredentialAuthorization
} from "@koed-labs/shared";

export interface OwnerBinding {
  readonly owner: string;
  readonly ownerUserId: string;
  readonly credentialKeyId: string;
}

export interface OwnerBindingOptions {
  koedHome: string;
  deploymentProfile: string;
  resolveActiveLocalUser: (userId: string) => Promise<{ id: string } | null>;
  reportOperationalFailure: (category: "custody" | "user_lookup") => void;
}

/**
 * Snapshot of local custody and active User, not authentication of an IPC sender.
 * A trusted channel must be bound separately. Changes may race this check or
 * later work; this does not guarantee immediate revocation or cancellation.
 */
export async function resolveOwnerBinding(
  options: OwnerBindingOptions
): Promise<OwnerBinding | null> {
  if (options.deploymentProfile !== "local_personal") return null;
  let phase: "custody" | "user_lookup" = "custody";
  try {
    const stored = readDesktopLocalCredentialAuthorization(options.koedHome);
    if (!stored) return null;
    const input = {
      ownerUserId: stored.ownerUserId,
      operationFamily: "personal_collaboration_write"
    };
    // Self-verification checks custody consistency, not sender possession.
    const verify = () =>
      verifyDesktopLocalCredentialAuthorization(
        options.koedHome,
        stored.authorization,
        input
      );
    if (!verify()) return null;
    phase = "user_lookup";
    const user = await options.resolveActiveLocalUser(stored.ownerUserId);
    if (!user || user.id !== stored.ownerUserId) return null;
    phase = "custody";
    const current = verify();
    if (!current || current.credentialKeyId !== stored.credentialKeyId)
      return null;
    return Object.freeze({
      owner: `desktop:${current.credentialKeyId}`,
      ownerUserId: current.ownerUserId,
      credentialKeyId: current.credentialKeyId
    });
  } catch {
    try {
      options.reportOperationalFailure(phase);
    } catch {
      throw new Error("Owner binding failure reporter unavailable");
    }
    return null;
  }
}

/** Recheck before new admission; old bindings remain needed for separate drain. */
export async function recheckOwnerBinding(
  options: OwnerBindingOptions,
  binding: OwnerBinding
): Promise<boolean> {
  const current = await resolveOwnerBinding(options);
  return (
    current !== null &&
    current.owner === binding.owner &&
    current.ownerUserId === binding.ownerUserId &&
    current.credentialKeyId === binding.credentialKeyId
  );
}

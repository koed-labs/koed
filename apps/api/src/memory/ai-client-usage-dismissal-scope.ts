import { createHash } from "node:crypto";

type Binding = {
  instanceId: string;
  accountIdentityHash: string | null;
  profileScopeHash: string;
  observedAt: string;
};

/** Opaque renderer scope for Keep decisions. Probe timestamps must not change it. */
export function aiClientUsageDismissalScope(
  ownerId: string,
  profileScopeHash: string,
  bindings: readonly Binding[]
): string {
  const accounts = bindings
    .filter((binding) => binding.profileScopeHash === profileScopeHash)
    .map(
      (binding) => [binding.instanceId, binding.accountIdentityHash] as const
    )
    .sort(([first], [second]) => first.localeCompare(second));
  return createHash("sha256")
    .update(JSON.stringify([ownerId, profileScopeHash, accounts]))
    .digest("hex");
}

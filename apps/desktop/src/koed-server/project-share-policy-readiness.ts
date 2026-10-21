import { resolve } from "node:path";
import {
  readDesktopLocalCredentialAuthorization,
  readLocalEdgeClientCredentialAuthorization,
  readLocalEdgeUpstreamRegistry
} from "@koed/shared";

type LocalCustody = { scope: string | null; hasTeamCustody: boolean };

/** A setup-status observation is only valid for the local Desktop profile
 * that was current when it was read. No CLI or network call belongs here. */
export const createProjectSharePolicyReadiness = (input: {
  koedHome(): string;
  readCurrent?: () => LocalCustody;
}) => {
  const current = (): LocalCustody => {
    if (input.readCurrent) return input.readCurrent();
    try {
      const koedHome = input.koedHome();
      const credential = readDesktopLocalCredentialAuthorization(koedHome);
      const registry = readLocalEdgeUpstreamRegistry(
        resolve(koedHome, "config", "upstream-backends.json")
      );
      return {
        scope: credential
          ? `${koedHome}\u0000${credential.ownerUserId}\u0000${credential.credentialKeyId}\u0000${credential.authorization}`
          : null,
        hasTeamCustody: registry.backends.some((backend) =>
          readLocalEdgeClientCredentialAuthorization(
            koedHome,
            backend.id
          )?.operationFamilies.includes("share_grant_management")
        )
      };
    } catch {
      return { scope: null, hasTeamCustody: false };
    }
  };
  let observedScope: string | null = null;
  let registered = false;
  return {
    observe(status: unknown) {
      const snapshot = current();
      const upstream =
        status && typeof status === "object" && "upstreamBackends" in status
          ? status.upstreamBackends
          : null;
      const count =
        upstream && typeof upstream === "object" && "registered" in upstream
          ? upstream.registered
          : null;
      observedScope = snapshot.scope;
      registered = typeof count === "number" && count > 0;
    },
    noteRegistered() {
      observedScope = current().scope;
      registered = observedScope !== null;
    },
    eligible() {
      const snapshot = current();
      return (
        registered &&
        snapshot.scope !== null &&
        snapshot.scope === observedScope &&
        snapshot.hasTeamCustody
      );
    }
  };
};

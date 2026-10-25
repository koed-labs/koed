import type { AgentsAuthority } from "./agents-client.js";

/** Cache endpoint discovery, never identity checks or the authority of a write. */
export function createAgentsAuthorityResolver(input: {
  revision: () => string;
  credential: () => { ownerUserId: string; authorization: string } | null;
  discover: () => Promise<{ apiOrigin: string; authorization: string }>;
}): () => Promise<AgentsAuthority> {
  let endpoint: { revision: string; apiOrigin: string } | null = null;
  return async () => {
    const revision = input.revision();
    const before = input.credential();
    if (!before) throw new Error("Agents authority is unavailable.");
    if (!endpoint || endpoint.revision !== revision) {
      const discovered = await input.discover();
      const after = input.credential();
      if (
        input.revision() !== revision ||
        after?.ownerUserId !== before.ownerUserId ||
        after?.authorization !== before.authorization ||
        discovered.authorization !== before.authorization
      )
        throw new Error("Agents profile changed during endpoint discovery.");
      endpoint = { revision, apiOrigin: discovered.apiOrigin };
    }
    return {
      key: `${revision}\0${endpoint.apiOrigin}\0${before.authorization}\0${before.ownerUserId}`,
      ownerId: before.ownerUserId,
      apiOrigin: endpoint.apiOrigin,
      authorization: before.authorization
    };
  };
}

export type DraftAuthority =
  | {
      scope: "personal";
      principalId: string;
      threadId: string;
    }
  | {
      scope: "team";
      backendId: string;
      principalId: string;
      teamId: string;
      workspaceId: string | null;
      threadId: string;
    };

export const draftAuthorityKey = (authority: DraftAuthority): string =>
  authority.scope === "personal"
    ? `personal:${authority.principalId}:${authority.threadId}`
    : [
        "team",
        authority.backendId,
        authority.principalId,
        authority.teamId,
        authority.workspaceId ?? "-",
        authority.threadId
      ].join(":");

export const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

export class DraftStore {
  readonly #drafts = new Map<string, string>();
  readonly #listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get(authority: DraftAuthority): string {
    return this.#drafts.get(draftAuthorityKey(authority)) ?? "";
  }

  set(authority: DraftAuthority, value: string): void {
    const key = draftAuthorityKey(authority);
    if (!value) this.#drafts.delete(key);
    else this.#drafts.set(key, value);
    this.#emit();
  }

  purge(authority: DraftAuthority): void {
    if (this.#drafts.delete(draftAuthorityKey(authority))) this.#emit();
  }

  reconcileAuthorized(
    isAuthorized: (authority: DraftAuthority) => boolean
  ): void {
    let changed = false;
    for (const key of this.#drafts.keys()) {
      const authority = parseDraftAuthorityKey(key);
      if (!authority || !isAuthorized(authority)) {
        this.#drafts.delete(key);
        changed = true;
      }
    }
    if (changed) this.#emit();
  }

  get size(): number {
    return this.#drafts.size;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

const parseDraftAuthorityKey = (key: string): DraftAuthority | null => {
  const parts = key.split(":");
  if (parts[0] === "personal" && parts.length === 3) {
    return {
      scope: "personal",
      principalId: parts[1]!,
      threadId: parts[2]!
    };
  }
  if (parts[0] === "team" && parts.length === 6) {
    return {
      scope: "team",
      backendId: parts[1]!,
      principalId: parts[2]!,
      teamId: parts[3]!,
      workspaceId: parts[4] === "-" ? null : parts[4]!,
      threadId: parts[5]!
    };
  }
  return null;
};

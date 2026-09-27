export type RepositoryPreference = {
  id: string;
  fullName: string;
};

export function getSessionStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function repositoryPreferenceKey(
  mode: "demo" | "live",
  accountLogin: string
) {
  return `koed:studio:github-repository:${mode}:${accountLogin.trim().toLocaleLowerCase("en-US")}`;
}

export function readRepositoryPreference(
  storage: Pick<Storage, "getItem"> | undefined,
  key: string
): RepositoryPreference | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const candidate = value as { id?: unknown; fullName?: unknown };
    return typeof candidate.id === "string" &&
      typeof candidate.fullName === "string" &&
      candidate.id !== "" &&
      candidate.fullName !== ""
      ? { id: candidate.id, fullName: candidate.fullName }
      : null;
  } catch {
    return null;
  }
}

export function writeRepositoryPreference(
  storage: Pick<Storage, "setItem"> | undefined,
  key: string,
  preference: RepositoryPreference
) {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(preference));
  } catch {
    // Session storage may be disabled or full; selection remains in memory.
  }
}

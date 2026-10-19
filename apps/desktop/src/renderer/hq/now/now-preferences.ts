const key = "koed.hq.now.v1";
export type NowPreferences = { needsFolded: boolean; projectsFolded: boolean };
export const defaultNowPreferences: NowPreferences = {
  needsFolded: false,
  projectsFolded: false
};

export function readNowPreferences(): NowPreferences {
  try {
    const value = JSON.parse(
      localStorage.getItem(key) ?? "null"
    ) as Partial<NowPreferences> | null;
    return {
      needsFolded: value?.needsFolded === true,
      projectsFolded: value?.projectsFolded === true
    };
  } catch {
    return defaultNowPreferences;
  }
}

export function writeNowPreferences(value: NowPreferences): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage may be unavailable. */
  }
}

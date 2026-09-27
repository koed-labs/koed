import { describe, expect, it } from "vitest";
import {
  readRepositoryPreference,
  repositoryPreferenceKey,
  writeRepositoryPreference
} from "./PullRequestsView.storage";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  };
}

describe("pull request repository preference", () => {
  it("separates preferences by mode and account", () => {
    expect(repositoryPreferenceKey("demo", "Operator")).not.toBe(
      repositoryPreferenceKey("live", "operator")
    );
    expect(repositoryPreferenceKey("live", "Operator")).toBe(
      repositoryPreferenceKey("live", "operator")
    );
  });

  it("round-trips only the repository identity", () => {
    const storage = memoryStorage();
    const key = repositoryPreferenceKey("live", "operator");
    writeRepositoryPreference(storage, key, {
      id: "42",
      fullName: "koed/studio"
    });
    expect(readRepositoryPreference(storage, key)).toEqual({
      id: "42",
      fullName: "koed/studio"
    });
    expect(readRepositoryPreference(storage, "missing")).toBeNull();
  });
});

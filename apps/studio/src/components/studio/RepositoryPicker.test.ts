import { describe, expect, it } from "vitest";
import { filterRepositoryOptions } from "./RepositoryPicker";

const repositories = [
  { id: "1", fullName: "Koed/Studio", private: false },
  { id: "2", fullName: "koed/server", private: true }
];

describe("RepositoryPicker search", () => {
  it("matches organization and repository names case-insensitively", () => {
    expect(filterRepositoryOptions(repositories, "KOED/STU")).toEqual([
      repositories[0]
    ]);
    expect(filterRepositoryOptions(repositories, "server")).toEqual([
      repositories[1]
    ]);
  });

  it("returns an empty result for no match", () => {
    expect(filterRepositoryOptions(repositories, "missing")).toEqual([]);
  });
});

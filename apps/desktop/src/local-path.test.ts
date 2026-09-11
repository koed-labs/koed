import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { localPathDescendant, normalizedLocalPath } from "./local-path.js";

describe("local path containment", () => {
  it.each([
    [posix, "/home/operator/koed"],
    [win32, "C:\\Users\\Operator\\koed"],
    [win32, "\\\\server\\share\\koed"]
  ] as const)("matches native descendants under %s %s", (path, home) => {
    const root = path.join(home, "managed-conversations", "independent");
    const child = path.join(root, "conversation");
    expect(localPathDescendant(root, child)).toBe("conversation");
    expect(localPathDescendant(root, root)).toBeNull();
    expect(localPathDescendant(root, `${root}-other/conversation`)).toBeNull();
    expect(
      localPathDescendant(root, path.join(root, "..", "outside"))
    ).toBeNull();
    expect(
      localPathDescendant(root, path.join(root, "temp", "..", "conversation"))
    ).toBe("conversation");
    expect(normalizedLocalPath(`${root}${path.sep}`)).toBe(
      normalizedLocalPath(root)
    );
  });

  it("handles Windows separator and drive case differences without matching another drive", () => {
    expect(
      localPathDescendant("C:\\Koed\\independent", "c:/koed/independent/id")
    ).toBe("id");
    expect(
      localPathDescendant("C:\\Koed\\independent", "D:\\Koed\\independent\\id")
    ).toBeNull();
    expect(
      localPathDescendant("/Koed/independent", "/koed/independent/id")
    ).toBeNull();
  });
});

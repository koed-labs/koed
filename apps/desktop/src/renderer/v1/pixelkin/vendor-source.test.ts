import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const vendor = new URL("./vendor/", import.meta.url);
const source = JSON.parse(
  readFileSync(new URL("SOURCE.json", vendor), "utf8")
) as { package: string; commit: string; files: Record<string, string> };

describe("vendored Pixelkin engine", () => {
  it("matches the copy made by pixelkin:sync", () => {
    expect(source.package).toBe("@koed-labs/pixelkin");
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(readdirSync(vendor).sort()).toEqual(
      [...Object.keys(source.files), "SOURCE.json"].sort()
    );
    for (const [name, hash] of Object.entries(source.files))
      expect(
        createHash("sha256")
          .update(readFileSync(new URL(name, vendor)))
          .digest("hex"),
        `${name} was edited; change pixelkin-lab and run pixelkin:sync`
      ).toBe(hash);
  });
});

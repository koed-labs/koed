import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectLauncher,
  installLauncher,
  removeLauncher
} from "./launcher.js";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "koed cli "));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Desktop CLI launcher", () => {
  it("installs owned launcher with quoted paths and reports validated helper", async () => {
    const root = fixture();
    const input = {
      destination: join(root, "bin", "koed"),
      appPath: join(root, "Koed App.app"),
      helperPath: join(root, "Koed App.app", "Contents", "MacOS", "Koed"),
      cliPath: join(root, "Koed App.app", "Resources", "server", "cli.js"),
      expectedVersion: "0.8.1",
      currentPath: "/usr/bin"
    };
    mkdirSync(dirname(input.cliPath), { recursive: true });
    writeFileSync(input.cliPath, "// CLI entry\n");
    const status = await installLauncher({
      ...input,
      consent: true,
      probeHelper: async () => true
    });
    expect(status.ownership).toBe("koed");
    expect(status.helper).toBe("supported");
    expect(status.target).toBe("valid");
    expect(readFileSync(input.destination, "utf8")).toContain(
      "'" + input.helperPath + "'"
    );
  });

  it("reports missing or non-regular CLI targets", async () => {
    const root = fixture();
    const input = {
      destination: join(root, "koed"),
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      expectedVersion: "0.8.1",
      currentPath: "/usr/bin"
    };
    writeFileSync(input.cliPath, "// CLI entry\n");
    await installLauncher({
      ...input,
      consent: true,
      probeHelper: async () => true
    });
    rmSync(input.cliPath);
    await expect(
      inspectLauncher({ ...input, probeHelper: async () => false })
    ).resolves.toMatchObject({ target: "missing", helper: "unsupported" });
    writeFileSync(input.cliPath, "// CLI entry\n");
    await expect(
      inspectLauncher({ ...input, probeHelper: async () => true })
    ).resolves.toMatchObject({ target: "valid" });
  });

  it("removes only unchanged Koed-owned launcher", async () => {
    const root = fixture();
    const input = {
      destination: join(root, "bin", "koed"),
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      expectedVersion: "0.8.1",
      currentPath: "/usr/bin"
    };
    writeFileSync(input.cliPath, "// CLI entry\n");
    await installLauncher({
      ...input,
      consent: true,
      probeHelper: async () => true
    });
    await expect(
      removeLauncher({ ...input, probeHelper: async () => true })
    ).resolves.toMatchObject({ ownership: "absent" });
    await expect(
      removeLauncher({ ...input, probeHelper: async () => true })
    ).rejects.toThrow("unchanged Koed-owned");
  });

  it("revalidates launcher inode and contents after asynchronous helper probe", async () => {
    const root = fixture();
    const input = {
      destination: join(root, "koed"),
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      expectedVersion: "0.8.1",
      currentPath: "/usr/bin"
    };
    writeFileSync(input.cliPath, "// CLI entry\n");
    await installLauncher({
      ...input,
      consent: true,
      probeHelper: async () => true
    });
    await expect(
      removeLauncher({
        ...input,
        probeHelper: async () => {
          rmSync(input.destination);
          writeFileSync(
            input.destination,
            "# koed-desktop-launcher:v1\\nreplacement"
          );
          return true;
        }
      })
    ).rejects.toThrow("changed during removal");
    expect(readFileSync(input.destination, "utf8")).toContain("replacement");
  });

  it("refuses an unrelated destination and unsupported helper without replacing it", async () => {
    const root = fixture();
    const destination = join(root, "koed");
    writeFileSync(destination, "unrelated launcher");
    const input = {
      destination,
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      expectedVersion: "0.8.1",
      currentPath: "/usr/bin"
    };
    writeFileSync(input.cliPath, "// CLI entry\n");
    await expect(
      inspectLauncher({ ...input, probeHelper: async () => false })
    ).resolves.toMatchObject({
      ownership: "unrelated",
      helper: "unsupported"
    });
    await expect(
      installLauncher({
        ...input,
        consent: true,
        probeHelper: async () => true
      })
    ).rejects.toThrow(/conflict/);
    expect(readFileSync(destination, "utf8")).toBe("unrelated launcher");
  });
});

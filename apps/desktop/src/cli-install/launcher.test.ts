import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
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
  it("recognizes exact historical templates across version upgrades and removes them safely", async () => {
    const root = fixture();
    const input = {
      destination: join(root, "koed"),
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "Koed Home"),
      expectedVersion: "0.8.1",
      currentPath: root,
      probeHelper: async () => true
    };
    writeFileSync(input.cliPath, "// CLI entry\n");
    await installLauncher({ ...input, consent: true });
    const upgraded = { ...input, expectedVersion: "0.9.0" };
    await expect(inspectLauncher(upgraded)).resolves.toMatchObject({
      ownership: "koed",
      target: "valid",
      version: "0.8.1"
    });
    await expect(removeLauncher(upgraded)).resolves.toMatchObject({
      ownership: "absent"
    });
  });

  it("rejects invalid version fields, modified historical templates and symlinks", async () => {
    const root = fixture();
    const input = {
      destination: join(root, "koed"),
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "cli.js"),
      koedHome: join(root, "Koed Home"),
      expectedVersion: "0.8.1",
      currentPath: root,
      probeHelper: async () => true
    };
    writeFileSync(input.cliPath, "// CLI entry\n");
    await installLauncher({ ...input, consent: true });
    const original = readFileSync(input.destination, "utf8");
    for (const contents of [
      original.replace("0.8.1", "01.8.1"),
      original.replace("0.8.1", "0.8.1-01"),
      original.replace("0.8.1", "0.8.1-.."),
      `${original}echo tampered\n`,
      original.replace(input.helperPath, `${input.helperPath}-other`)
    ]) {
      writeFileSync(input.destination, contents);
      await expect(inspectLauncher(input)).resolves.toMatchObject({
        ownership: "changed"
      });
      await expect(removeLauncher(input)).rejects.toThrow(
        "unchanged Koed-owned"
      );
    }
    writeFileSync(input.destination, original);
    const linked = { ...input, destination: join(root, "linked") };
    symlinkSync(input.destination, linked.destination);
    await expect(inspectLauncher(linked)).resolves.toMatchObject({
      ownership: "changed"
    });
    await expect(removeLauncher(linked)).rejects.toThrow(
      "unchanged Koed-owned"
    );
    expect(readFileSync(input.destination, "utf8")).toBe(original);
  });
  it("installs owned launcher with quoted paths and reports validated helper", async () => {
    const root = fixture();
    const input = {
      destination: join(root, "bin", "koed"),
      appPath: join(root, "Koed App.app"),
      helperPath: join(root, "Koed App.app", "Contents", "MacOS", "Koed"),
      cliPath: join(root, "Koed App.app", "Resources", "server", "cli.js"),
      koedHome: join(root, "Koed Home"),
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
      koedHome: join(root, "Koed Home"),
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
      koedHome: join(root, "Koed Home"),
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
      koedHome: join(root, "Koed Home"),
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
            "#!/bin/sh\\n# koed-desktop-launcher:v2\\nreplacement"
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
      koedHome: join(root, "Koed Home"),
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

  it("binds the quoted Desktop KOED_HOME and runs the verified Desktop entrypoint", async () => {
    const root = fixture();
    const input = {
      destination: join(root, "bin", "koed"),
      appPath: join(root, "Koed's Apps", "Koed.app"),
      helperPath: join(
        root,
        "Koed's Apps",
        "Koed.app",
        "Contents",
        "MacOS",
        "Koed"
      ),
      cliPath: join(root, "Koed's Apps", "entry.js"),
      koedHome: join(root, "Desktop Home's state"),
      expectedVersion: "0.9.0",
      currentPath: "/usr/bin",
      probeHelper: async () => true
    };
    mkdirSync(dirname(input.cliPath), { recursive: true });
    writeFileSync(input.cliPath, "// entry\n");
    await installLauncher({ ...input, consent: true });
    const contents = readFileSync(input.destination, "utf8");
    expect(contents).toBe(
      [
        "#!/bin/sh",
        "# koed-desktop-launcher:v2",
        "# version:0.9.0",
        "export ELECTRON_RUN_AS_NODE=1",
        `export KOED_HOME='${input.koedHome.replace("'", "'\\''")}'`,
        `exec '${input.helperPath.replace("'", "'\\''")}' '${input.cliPath.replace("'", "'\\''")}' "$@"`,
        ""
      ].join("\n")
    );
    const shell = spawnSync("/bin/sh", [
      "-c",
      `${contents.split("\n").slice(4, 5).join("")}; printf %s "$KOED_HOME"`
    ]);
    expect(shell.stdout.toString()).toBe(input.koedHome);
    await expect(
      inspectLauncher({ ...input, koedHome: join(root, "other") })
    ).resolves.toMatchObject({ ownership: "changed" });
    await expect(
      installLauncher({ ...input, consent: true, koedHome: "relative" })
    ).rejects.toThrow(/absolute/);
  });

  it("migrates an unchanged v1 launcher but never overwrites an edited one", async () => {
    const root = fixture();
    const input = {
      destination: join(root, "koed"),
      appPath: root,
      helperPath: join(root, "Koed"),
      cliPath: join(root, "entry.js"),
      legacyCliPath: join(root, "cli.js"),
      koedHome: join(root, "home"),
      expectedVersion: "0.9.0",
      currentPath: root,
      probeHelper: async () => true
    };
    writeFileSync(input.cliPath, "// entry\n");
    const legacy = `# koed-desktop-launcher:v1\n# version:0.8.1\nexport ELECTRON_RUN_AS_NODE=1\nexec '${input.helperPath}' '${input.legacyCliPath}' "$@"\n`;
    writeFileSync(input.destination, legacy);
    await expect(inspectLauncher(input)).resolves.toMatchObject({
      ownership: "koed",
      template: "legacy",
      version: "0.8.1"
    });
    await expect(
      installLauncher({ ...input, consent: true })
    ).resolves.toMatchObject({ ownership: "koed", template: "current" });
    expect(readFileSync(input.destination, "utf8")).toContain("KOED_HOME");
    writeFileSync(input.destination, `${legacy}echo edited\n`);
    await expect(inspectLauncher(input)).resolves.toMatchObject({
      ownership: "changed"
    });
    await expect(installLauncher({ ...input, consent: true })).rejects.toThrow(
      /conflict/
    );
    expect(readFileSync(input.destination, "utf8")).toContain("echo edited");
    await expect(
      inspectLauncher({ ...input, legacyCliPath: undefined })
    ).resolves.toMatchObject({ ownership: "changed" });
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { canonicalArtifactJson } from "../../packages/koed-server/src/artifact-canonical-json.mjs";
import { writeDeterministicTarGz } from "../deterministic-tar-gzip.mjs";
import { coreRecipeId } from "./core-artifact.mjs";
import { verifyApprovedMacosCore } from "./verify-approved-macos-core.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixture = (content = "safe") => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch/archive-trust-"));
  const tree = resolve(root, "tree");
  mkdirSync(tree);
  const inventory = [
    {
      path: "file",
      type: "file",
      mode: 0o644,
      bytes: Buffer.byteLength(content),
      sha256: hash(content)
    },
    {
      path: "provenance.json",
      type: "file",
      mode: 0o644,
      bytes: 1,
      sha256: hash("p")
    }
  ];
  const approvedSha256 = coreRecipeId(inventory);
  const payload = inventory.slice(0, 1);
  const manifest = {
    schemaVersion: 1,
    kind: "core",
    recipe: {
      approvedDesktopInventorySha256: approvedSha256,
      frozenInventorySha256: coreRecipeId(payload)
    },
    inventory: payload
  };
  manifest.recipeId = coreRecipeId(manifest.recipe);
  const raw = `${canonicalArtifactJson(manifest)}\n`;
  writeFileSync(resolve(tree, "file"), content, { mode: 0o644 });
  writeFileSync(resolve(tree, "native-core-manifest.json"), raw, {
    mode: 0o644
  });
  const archivePath = resolve(root, "core.tar.gz");
  const externalManifestPath = resolve(root, "manifest.json");
  writeFileSync(externalManifestPath, raw);
  writeDeterministicTarGz({
    sourceDir: tree,
    rootName: "koed-runtime",
    tarPath: archivePath
  });
  const pin = () => {
    const bytes = readFileSync(externalManifestPath);
    const current = JSON.parse(bytes);
    return {
      sha256: hash(readFileSync(archivePath)),
      archiveBytes: readFileSync(archivePath).length,
      manifestSha256: hash(bytes),
      recipeId: current.recipeId,
      expandedBytes: current.inventory.reduce(
        (sum, entry) => sum + (entry.type === "file" ? entry.bytes : 0),
        bytes.length
      )
    };
  };
  return {
    root,
    tree,
    archivePath,
    externalManifestPath,
    fullInventory: inventory,
    approvedSha256,
    pin
  };
};
const verify = (f, extra = {}) =>
  verifyApprovedMacosCore({ ...f, pin: f.pin(), ...extra });
const mutate = (f, edit) => {
  const tar = gunzipSync(readFileSync(f.archivePath));
  edit(tar);
  writeFileSync(f.archivePath, gzipSync(tar));
};
const checksum = (header) => {
  header.fill(32, 148, 156);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(7, "0")}\0`, 148, 8);
};

test("verifies actual archive and both manifests against independent approval", async () => {
  const f = fixture();
  try {
    await verify(f);
    await assert.rejects(verify(f, { approvedSha256: undefined }));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("coherent attacker archive, inventory, manifests, recipe and catalog pin cannot replace independent approval", async () => {
  const approved = fixture();
  const attacker = fixture("evil");
  try {
    const catalog = { macosCore: attacker.pin() };
    await verify(attacker);
    await assert.rejects(
      verify(attacker, {
        pin: catalog.macosCore,
        approvedSha256: approved.approvedSha256
      })
    );
  } finally {
    rmSync(approved.root, { recursive: true, force: true });
    rmSync(attacker.root, { recursive: true, force: true });
  }
});

test("rejects changed archive payload and embedded manifest even with updated archive pin", async () => {
  for (const offset of [1024, 2048]) {
    const f = fixture();
    try {
      mutate(f, (tar) => {
        tar[offset] ^= 1;
      });
      await assert.rejects(verify(f));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("rejects traversal, hard links, duplicate paths and unsupported extensions", async () => {
  for (const kind of ["traversal", "hardlink", "duplicate", "extension"]) {
    const f = fixture();
    try {
      mutate(f, (tar) => {
        const header = tar.subarray(512, 1024);
        if (kind === "traversal") {
          header.fill(0, 0, 100);
          header.write("koed-runtime/../bad");
        }
        if (kind === "hardlink") header.write("1", 156);
        if (kind === "extension") header.write("g", 156);
        if (kind === "duplicate") {
          header.fill(0, 0, 100);
          header.write("koed-runtime/");
        }
        checksum(header);
      });
      await assert.rejects(verify(f), kind);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("accepts bounded PAX paths and approved contained symlinks", async () => {
  const f = fixture();
  try {
    const a = "a".repeat(90),
      b = "b".repeat(90),
      c = "c".repeat(90);
    mkdirSync(resolve(f.tree, a, b), { recursive: true });
    writeFileSync(resolve(f.tree, a, b, c), "long", { mode: 0o644 });
    symlinkSync("file", resolve(f.tree, "link"));
    f.fullInventory = [
      { path: a, type: "directory", mode: 0o755 },
      { path: `${a}/${b}`, type: "directory", mode: 0o755 },
      {
        path: `${a}/${b}/${c}`,
        type: "file",
        mode: 0o644,
        bytes: 4,
        sha256: hash("long")
      },
      f.fullInventory[0],
      { path: "link", type: "symlink", mode: 0o777, target: "file" },
      f.fullInventory[1]
    ];
    f.approvedSha256 = coreRecipeId(f.fullInventory);
    const projected = f.fullInventory.slice(0, -1);
    const manifest = {
      schemaVersion: 1,
      kind: "core",
      recipe: {
        approvedDesktopInventorySha256: f.approvedSha256,
        frozenInventorySha256: coreRecipeId(projected)
      },
      inventory: projected
    };
    manifest.recipeId = coreRecipeId(manifest.recipe);
    const raw = `${canonicalArtifactJson(manifest)}\n`;
    writeFileSync(resolve(f.tree, "native-core-manifest.json"), raw);
    writeFileSync(f.externalManifestPath, raw);
    writeDeterministicTarGz({
      sourceDir: f.tree,
      rootName: "koed-runtime",
      tarPath: f.archivePath
    });
    await verify(f);
    mutate(f, (tar) => {
      const marker = Buffer.from("koed-runtime/link");
      const offset = tar.indexOf(marker);
      const header = tar.subarray(offset, offset + 512);
      header.fill(0, 157, 257);
      header.write("../escape", 157);
      checksum(header);
    });
    await assert.rejects(verify(f));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

const longLinkFixture = () => {
  const f = fixture();
  const a = "a".repeat(90),
    b = "b".repeat(90),
    c = "c".repeat(90);
  const directory = `${a}/${b}/${c}`;
  const target = `${directory}/file`;
  const nestedTarget = `../../../${target}`;
  mkdirSync(resolve(f.tree, directory), { recursive: true });
  writeFileSync(resolve(f.tree, target), "long", { mode: 0o644 });
  symlinkSync(nestedTarget, resolve(f.tree, directory, "link"));
  symlinkSync(target, resolve(f.tree, "link"));
  f.fullInventory = [
    { path: a, type: "directory", mode: 0o755 },
    { path: `${a}/${b}`, type: "directory", mode: 0o755 },
    { path: directory, type: "directory", mode: 0o755 },
    { path: target, type: "file", mode: 0o644, bytes: 4, sha256: hash("long") },
    {
      path: `${directory}/link`,
      type: "symlink",
      mode: 0o777,
      target: nestedTarget
    },
    f.fullInventory[0],
    { path: "link", type: "symlink", mode: 0o777, target },
    f.fullInventory[1]
  ];
  f.approvedSha256 = coreRecipeId(f.fullInventory);
  const inventory = f.fullInventory.slice(0, -1);
  const manifest = {
    schemaVersion: 1,
    kind: "core",
    recipe: {
      approvedDesktopInventorySha256: f.approvedSha256,
      frozenInventorySha256: coreRecipeId(inventory)
    },
    inventory
  };
  manifest.recipeId = coreRecipeId(manifest.recipe);
  const raw = `${canonicalArtifactJson(manifest)}\n`;
  writeFileSync(resolve(f.tree, "native-core-manifest.json"), raw);
  writeFileSync(f.externalManifestPath, raw);
  writeDeterministicTarGz({
    sourceDir: f.tree,
    rootName: "koed-runtime",
    tarPath: f.archivePath,
    streaming: true
  });
  return f;
};

const paxExtensions = (tar) => {
  const result = [];
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(
      header.subarray(124, 136).toString("ascii"),
      8
    );
    if (header[156] === 120)
      result.push({
        offset,
        content: tar.subarray(offset + 512, offset + 512 + size)
      });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
};

test("accepts real writer long linkpath and combined path/linkpath PAX records", async () => {
  const f = longLinkFixture();
  try {
    const extensions = paxExtensions(gunzipSync(readFileSync(f.archivePath)));
    const lines = extensions.map(({ content }) => content.toString("utf8"));
    assert(
      lines.some(
        (line) => line.includes(" linkpath=") && !line.includes(" path=")
      )
    );
    assert(
      lines.some(
        (line) => line.includes(" path=") && line.includes(" linkpath=")
      )
    );
    await verify(f);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects high-bit PAX length digits masking unsafe physical paths and link targets", async () => {
  const f = longLinkFixture();
  try {
    const original = gunzipSync(readFileSync(f.archivePath));
    for (const [kind, digit] of [
      ["path", 0],
      ["path", 1],
      ["linkpath", 0],
      ["linkpath", 1],
      ["combined-linkpath", 0],
      ["combined-linkpath", 1]
    ]) {
      const tar = Buffer.from(original);
      const extension = paxExtensions(tar).find(({ content }) => {
        const records = content.toString("utf8");
        return kind === "path"
          ? records.includes(" path=") && !records.includes(" linkpath=")
          : kind === "linkpath"
            ? records.includes(" linkpath=") && !records.includes(" path=")
            : records.includes(" path=") && records.includes(" linkpath=");
      });
      assert(extension, kind);
      const content = extension.content;
      const recordStart =
        kind === "combined-linkpath" ? content.indexOf(10) + 1 : 0;
      assert(content[recordStart] >= 0x31 && content[recordStart] <= 0x39);
      assert(
        content[recordStart + digit] >= 0x30 &&
          content[recordStart + digit] <= 0x39
      );
      content[recordStart + digit] |= 0x80;
      const size = content.length;
      const headerOffset = extension.offset + 512 + Math.ceil(size / 512) * 512;
      const header = tar.subarray(headerOffset, headerOffset + 512);
      if (kind === "path") {
        header.fill(0, 0, 100);
        header.write("../escape");
      } else {
        header.fill(0, 157, 257);
        header.write("../../escape", 157);
      }
      checksum(header);
      writeFileSync(f.archivePath, gzipSync(tar));
      await assert.rejects(verify(f), /Invalid PAX length/, kind);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects malformed effective PAX paths and link targets", async () => {
  const f = longLinkFixture();
  try {
    const original = gunzipSync(readFileSync(f.archivePath));
    for (const [key, value] of [
      ["path", "../"],
      ["linkpath", "/"],
      ["path", "\0"],
      ["linkpath", "\0"]
    ]) {
      const tar = Buffer.from(original);
      const extension = paxExtensions(tar).find(({ content }) =>
        content.includes(Buffer.from(` ${key}=`))
      );
      assert(extension, key);
      const marker = Buffer.from(` ${key}=`);
      const start = extension.content.indexOf(marker) + marker.length;
      extension.content.write(value, start);
      writeFileSync(f.archivePath, gzipSync(tar));
      await assert.rejects(verify(f), `${key}: ${JSON.stringify(value)}`);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects altered mode, missing entry, extra entry, and incorrect archive pin", async () => {
  for (const kind of ["mode", "missing", "extra", "pin"]) {
    const f = fixture();
    try {
      if (kind === "pin") {
        await assert.rejects(
          verify(f, { pin: { ...f.pin(), sha256: "0".repeat(64) } })
        );
        continue;
      }
      mutate(f, (tar) => {
        const header = tar.subarray(512, 1024);
        if (kind === "mode") {
          header.write("0000755\0", 100);
          checksum(header);
        }
        if (kind === "missing") tar.fill(0, 512);
        if (kind === "extra") {
          header.fill(0, 0, 100);
          header.write("koed-runtime/extra");
          checksum(header);
        }
      });
      await assert.rejects(verify(f), kind);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("rejects invalid gzip bytes even when archive pin matches", async () => {
  const f = fixture();
  try {
    writeFileSync(f.archivePath, Buffer.from("not a gzip archive"));
    await assert.rejects(verify(f));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects oversized tar entry before decompressing its claimed content", async () => {
  const f = fixture();
  try {
    mutate(f, (tar) => {
      const header = tar.subarray(512, 1024);
      header.write(`${(100000001).toString(8).padStart(11, "0")}\0`, 124);
      checksum(header);
    });
    await assert.rejects(verify(f), /limit/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects mismatched external manifest and trailing tar data", async () => {
  const f = fixture();
  try {
    const pin = f.pin();
    writeFileSync(f.externalManifestPath, "{}");
    await assert.rejects(verifyApprovedMacosCore({ ...f, pin }));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
  const g = fixture();
  try {
    mutate(g, (tar) => {
      tar[tar.length - 1] = 1;
    });
    await assert.rejects(verify(g));
  } finally {
    rmSync(g.root, { recursive: true, force: true });
  }
});

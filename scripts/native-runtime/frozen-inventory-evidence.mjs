import { createHash } from "node:crypto";
import { closeSync, createReadStream, fstatSync, openSync } from "node:fs";
import { fromFd } from "yauzl";
import { canonicalArtifactJson } from "../../packages/koed-server/src/artifact-canonical-json.mjs";
import { coreRecipeId } from "./core-artifact.mjs";
import { verifyApprovedMacosInventory } from "./macos-inventory.mjs";

const evidenceName = "approved-macos-inventory.json";
const maxEvidenceBytes = 16 * 1024 * 1024;
const maxArchiveBytes = 4 * 1024 ** 3;

const digestFile = async (fd, size) => {
  const hash = createHash("sha256");
  if (size > 0)
    for await (const chunk of createReadStream(null, {
      fd,
      autoClose: false,
      start: 0,
      end: size - 1
    }))
      hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
};

const openZip = (fd) =>
  new Promise((resolve, reject) => {
    fromFd(
      fd,
      {
        autoClose: false,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true
      },
      (error, zip) => (error ? reject(error) : resolve(zip))
    );
  });

const readEntry = (zip, entry) =>
  new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxEvidenceBytes)
          stream.destroy(new Error("Inventory evidence exceeds size limit."));
        else chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });

const inventoryBytes = async (fd, version) => {
  const frozenName = `koed-native-runtime-macos-arm64-${version}.tar.gz`;
  const zip = await openZip(fd);
  if (zip.entryCount !== 2)
    throw new Error("Unexpected frozen artifact ZIP entry count.");
  return await new Promise((resolve, reject) => {
    const names = new Set();
    let evidence;
    zip.on("error", reject);
    zip.on("end", () => {
      if (names.size !== 2 || !evidence || !names.has(frozenName))
        reject(new Error("Missing or unexpected frozen artifact evidence."));
      else resolve(evidence);
    });
    zip.on("entry", async (entry) => {
      try {
        const name = entry.fileName;
        const unixMode = entry.externalFileAttributes >>> 16;
        if (
          names.has(name) ||
          !(name === evidenceName || name === frozenName) ||
          (unixMode && (unixMode & 0o170000) !== 0o100000) ||
          entry.generalPurposeBitFlag & 1
        )
          throw new Error("Invalid frozen artifact ZIP entry.");
        if (
          entry.uncompressedSize > maxArchiveBytes ||
          entry.compressedSize > maxArchiveBytes
        )
          throw new Error("Frozen artifact ZIP entry exceeds size limit.");
        names.add(name);
        if (name === evidenceName) {
          if (
            entry.uncompressedSize > maxEvidenceBytes ||
            entry.compressedSize > maxEvidenceBytes
          )
            throw new Error("Inventory evidence exceeds size limit.");
          evidence = await readEntry(zip, entry);
        }
        zip.readEntry();
      } catch (error) {
        reject(error);
      }
    });
    zip.readEntry();
  });
};

export const readFrozenInventoryEvidence = async ({
  archivePath,
  artifactDigest,
  approvedSha256,
  version
}) => {
  const fd = openSync(archivePath, "r");
  let bytes;
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxArchiveBytes))
      throw new Error(
        "Frozen artifact ZIP exceeds size limit or is not a regular file."
      );
    if (
      !/^sha256:[a-f0-9]{64}$/.test(artifactDigest ?? "") ||
      (await digestFile(fd, Number(before.size))) !== artifactDigest
    )
      throw new Error("Frozen artifact ZIP digest mismatch.");
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? ""))
      throw new Error("Invalid frozen artifact version.");
    bytes = await inventoryBytes(fd, version);
    const digest = await digestFile(fd, Number(before.size));
    const after = fstatSync(fd, { bigint: true });
    if (
      digest !== artifactDigest ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("Frozen artifact ZIP changed during verification.");
  } finally {
    closeSync(fd);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const inventory = JSON.parse(text);
  if (text !== `${canonicalArtifactJson(inventory)}\n`)
    throw new Error("Inventory evidence is not canonical JSON.");
  // Without a caller-supplied digest, the evidence is authenticated by the
  // artifact digest above, which the reviewed release identity binds.
  verifyApprovedMacosInventory(
    inventory,
    approvedSha256 ?? coreRecipeId(inventory)
  );
  return inventory;
};

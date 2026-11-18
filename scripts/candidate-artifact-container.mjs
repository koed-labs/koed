import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

const openZip = (path) =>
  new Promise((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, autoClose: false, strictFileNames: true },
      (error, zip) => (error ? reject(error) : resolve(zip))
    );
  });

const singleEntry = (zip, maxBytes) =>
  new Promise((resolve, reject) => {
    let found;
    zip.on("error", reject);
    zip.on("entry", (entry) => {
      const mode = entry.externalFileAttributes >>> 16;
      const unix = entry.versionMadeBy >>> 8 === 3;
      const kind = mode & 0o170000;
      if (
        found ||
        entry.fileName !== "unsigned.zip" ||
        entry.generalPurposeBitFlag & 1 ||
        (unix && kind && kind !== 0o100000) ||
        entry.uncompressedSize > maxBytes ||
        entry.compressedSize > maxBytes
      ) {
        reject(new Error("Invalid artifact payload entry or size limit"));
        return;
      }
      found = entry;
      zip.readEntry();
    });
    zip.on("end", () =>
      found ? resolve(found) : reject(new Error("Artifact payload missing"))
    );
    zip.readEntry();
  });

export const extractArtifactPayload = async (archive, output, { maxBytes }) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error("Invalid size limit");
  const zip = await openZip(archive);
  let file;
  try {
    const entry = await singleEntry(zip, maxBytes);
    file = await open(output, "wx", 0o600);
    const stream = await new Promise((resolve, reject) =>
      zip.openReadStream(entry, (error, value) =>
        error ? reject(error) : resolve(value)
      )
    );
    const hash = createHash("sha256");
    let count = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        count += chunk.length;
        if (count > maxBytes)
          return callback(new Error("Payload size limit exceeded"));
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    await pipeline(
      stream,
      meter,
      createWriteStream(output, { fd: file.fd, autoClose: false })
    );
    if (count !== entry.uncompressedSize)
      throw new Error("Payload size mismatch");
    return { sha256: hash.digest("hex"), size: count };
  } catch (error) {
    if (file) {
      try {
        await unlink(output);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Artifact extraction and cleanup failed",
          { cause: cleanupError }
        );
      }
    }
    throw error;
  } finally {
    if (file) await file.close();
    zip.close();
  }
};

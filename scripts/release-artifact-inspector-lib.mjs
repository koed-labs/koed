import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readdirSync, statSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";

const nativePattern = /\.(?:node|so(?:\.\d+)*|dylib|dll)$/i;
const textPattern = /\.(?:c?js|mjs|json|ya?ml|txt|md|sh|css|html|xml|toml)$/i;
const targetTokens = {
  linux: ["linux"],
  macos: ["darwin", "macos", "osx"],
  windows: ["win32", "windows"],
  x64: ["x64", "x86_64", "amd64"],
  arm64: ["arm64", "aarch64"]
};

const sha256File = (path) =>
  new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });

const contributor = (path) => {
  const parts = path.split("/");
  const index = parts.lastIndexOf("node_modules");
  if (index >= 0 && parts[index + 1]) {
    return parts[index + 1].startsWith("@")
      ? parts.slice(index + 1, index + 3).join("/")
      : parts[index + 1];
  }
  return parts[0] || ".";
};

const nativeRuntimeComponent = (path) => {
  const normalized = `/${path.toLowerCase()}`;
  const name = normalized.split("/").at(-1) ?? "";
  if (name === "runtime-asset-manifest.json" || name === "provenance.json") {
    return "manifests-and-provenance";
  }
  if (normalized.includes("/postgres/")) {
    return /(?:^|[._-])vector(?:[._-]|$)/.test(name)
      ? "pgvector"
      : "postgresql";
  }
  if (normalized.includes("/llama.cpp/cuda/")) {
    return /^libcu(?:dart|blas|blaslt)\.so(?:\.|$)/.test(name)
      ? "cuda-redistributable-libraries"
      : "llama.cpp-cuda";
  }
  if (
    normalized.includes("/llama.cpp/cpu/") ||
    normalized.endsWith("/llama.cpp/llama-server")
  ) {
    return "llama.cpp-cpu";
  }
  return null;
};

const foreignNative = (path, platform, architecture) => {
  if (!nativePattern.test(path)) return false;
  const lower = path.toLowerCase();
  const foreignPlatforms = Object.entries(targetTokens)
    .filter(([name]) => ["linux", "macos", "windows"].includes(name))
    .filter(([name]) => name !== platform)
    .flatMap(([, tokens]) => tokens);
  const foreignArchitectures = Object.entries(targetTokens)
    .filter(([name]) => ["x64", "arm64"].includes(name))
    .filter(([name]) => name !== architecture)
    .flatMap(([, tokens]) => tokens);
  return [...foreignPlatforms, ...foreignArchitectures].some((token) =>
    lower.includes(token)
  );
};

const createCollector = ({ platform, architecture }) => {
  const entries = [];
  return {
    entries,
    add(entry) {
      entries.push({ ...entry, path: entry.path.replaceAll("\\", "/") });
    },
    finish({ source, archiveBytes = null, manifestBytes = null }) {
      entries.sort((a, b) => a.path.localeCompare(b.path));
      const regular = entries.filter((entry) => entry.type === "file");
      const hashes = new Map();
      const contributors = new Map();
      const nativeComponents = new Map();
      for (const file of regular) {
        if (!hashes.has(file.sha256)) hashes.set(file.sha256, file.size);
        contributors.set(
          contributor(file.path),
          (contributors.get(contributor(file.path)) ?? 0) + file.size
        );
        const component = nativeRuntimeComponent(file.path);
        if (component) {
          nativeComponents.set(
            component,
            (nativeComponents.get(component) ?? 0) + file.size
          );
        }
      }
      const expandedBytes = regular.reduce((sum, file) => sum + file.size, 0);
      const uniqueContentBytes = [...hashes.values()].reduce(
        (sum, size) => sum + size,
        0
      );
      const archiveRatio =
        archiveBytes === null || expandedBytes === 0
          ? null
          : archiveBytes / expandedBytes;
      const counts = Object.fromEntries(
        ["file", "directory", "symlink", "special"].map((type) => [
          type,
          entries.filter((entry) => entry.type === type).length
        ])
      );
      return {
        schemaVersion: 1,
        source: basename(source),
        target: { platform, architecture },
        bytes: {
          archive: archiveBytes,
          manifest: manifestBytes,
          expandedRegularFiles: expandedBytes,
          uniqueContent: uniqueContentBytes,
          duplicateContent: expandedBytes - uniqueContentBytes,
          duplicateRatio:
            expandedBytes === 0
              ? 0
              : Number(
                  (
                    (expandedBytes - uniqueContentBytes) /
                    expandedBytes
                  ).toFixed(6)
                )
        },
        entryCounts: counts,
        largestFiles: regular
          .toSorted((a, b) => b.size - a.size || a.path.localeCompare(b.path))
          .slice(0, 20)
          .map(({ path, size, sha256 }) => ({ path, size, sha256 })),
        largestContributors: [...contributors]
          .map(([name, bytes]) => ({ name, bytes }))
          .toSorted((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
          .slice(0, 20),
        nativeRuntimeComponents: [...nativeComponents]
          .map(([name, expandedBytes]) => ({
            name,
            expandedBytes,
            estimatedCompressedBytes:
              archiveRatio === null
                ? null
                : Math.round(expandedBytes * archiveRatio)
          }))
          .toSorted(
            (a, b) =>
              b.expandedBytes - a.expandedBytes || a.name.localeCompare(b.name)
          ),
        findings: {
          symlinks: entries
            .filter((entry) => entry.type === "symlink")
            .map((entry) => entry.path),
          specialFiles: entries
            .filter((entry) => entry.type === "special")
            .map((entry) => entry.path),
          foreignPlatformNativeFiles: regular
            .filter((entry) =>
              foreignNative(entry.path, platform, architecture)
            )
            .map((entry) => entry.path),
          absolutePaths: entries
            .filter((entry) => entry.path.startsWith("/"))
            .map((entry) => entry.path),
          sourceCheckoutLeaks: regular
            .filter((entry) => entry.sourceCheckoutLeak)
            .map((entry) => entry.path)
        }
      };
    }
  };
};

const detectsCheckoutLeak = (buffer) =>
  /(?:\/Users\/[^/]+\/|\/home\/runner\/work\/|\/builds\/|[A-Za-z]:\\Users\\)/.test(
    buffer.toString("utf8")
  );

const tarString = (buffer, start, length) =>
  buffer
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/s, "");

const tarNumber = (buffer, start, length) => {
  const value = tarString(buffer, start, length).trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error("Malformed tar numeric field");
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result))
    throw new Error("Oversized tar numeric field");
  return result;
};

const parsePax = (content) => {
  const result = {};
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space < 0) throw new Error("Malformed pax header");
    const length = Number.parseInt(
      content.subarray(offset, space).toString("ascii"),
      10
    );
    if (!Number.isSafeInteger(length) || offset + length > content.length) {
      throw new Error("Truncated pax header");
    }
    const record = content
      .subarray(space + 1, offset + length - 1)
      .toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) throw new Error("Malformed pax record");
    result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
};

export const inspectTree = async ({ path, platform, architecture }) => {
  const root = resolve(path);
  const collector = createCollector({ platform, architecture });
  const visit = async (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted(
      (a, b) => a.name.localeCompare(b.name)
    )) {
      const absolute = resolve(dir, entry.name);
      const name = relative(root, absolute).split(sep).join("/");
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        collector.add({ path: name, type: "directory", size: 0 });
        await visit(absolute);
      } else if (stat.isFile()) {
        let sourceCheckoutLeak = false;
        if (stat.size <= 16 * 1024 * 1024 && textPattern.test(name)) {
          for await (const chunk of createReadStream(absolute)) {
            if (detectsCheckoutLeak(chunk)) sourceCheckoutLeak = true;
          }
        }
        collector.add({
          path: name,
          type: "file",
          size: stat.size,
          sha256: await sha256File(absolute),
          sourceCheckoutLeak
        });
      } else if (stat.isSymbolicLink()) {
        collector.add({ path: name, type: "symlink", size: 0 });
      } else {
        collector.add({ path: name, type: "special", size: 0 });
      }
    }
  };
  await visit(root);
  const manifest = resolve(root, "koed-server-package-manifest.json");
  return collector.finish({
    source: root,
    manifestBytes: statSync(manifest, { throwIfNoEntry: false })?.size ?? null
  });
};

export const inspectArchive = async ({ path, platform, architecture }) => {
  const archive = resolve(path);
  const collector = createCollector({ platform, architecture });
  const stream = createReadStream(archive).pipe(createGunzip());
  let buffer = Buffer.alloc(0);
  let pax = {};
  let manifestBytes = null;
  let current;
  let ended = false;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    buffer = buffer.length === 0 ? bytes : Buffer.concat([buffer, bytes]);
    while (true) {
      if (current) {
        if (current.remaining > 0 && buffer.length > 0) {
          const length = Math.min(current.remaining, buffer.length);
          const part = buffer.subarray(0, length);
          buffer = buffer.subarray(length);
          current.remaining -= length;
          current.hash?.update(part);
          if (current.capture) current.chunks.push(Buffer.from(part));
          if (current.scan && detectsCheckoutLeak(part)) current.leak = true;
        }
        if (current.remaining > 0 || buffer.length < current.padding) break;
        buffer = buffer.subarray(current.padding);
        if (current.type === "x") {
          pax = parsePax(Buffer.concat(current.chunks));
        } else {
          collector.add({
            path: current.path,
            type: current.type,
            size: current.size,
            ...(current.hash ? { sha256: current.hash.digest("hex") } : {}),
            ...(current.leak ? { sourceCheckoutLeak: true } : {})
          });
        }
        current = undefined;
        continue;
      }
      if (buffer.length < 512) break;
      const header = buffer.subarray(0, 512);
      buffer = buffer.subarray(512);
      if (header.every((byte) => byte === 0)) {
        ended = true;
        break;
      }
      const typeCode = tarString(header, 156, 1) || "0";
      const size = tarNumber(header, 124, 12);
      const padding = (512 - (size % 512)) % 512;
      if (typeCode === "x") {
        current = {
          type: "x",
          remaining: size,
          padding,
          capture: true,
          chunks: []
        };
        continue;
      }
      const name = tarString(header, 0, 100);
      const prefix = tarString(header, 345, 155);
      const entryPath = pax.path ?? (prefix ? `${prefix}/${name}` : name);
      pax = {};
      const type =
        typeCode === "0" || typeCode === ""
          ? "file"
          : typeCode === "5"
            ? "directory"
            : typeCode === "2" || typeCode === "1"
              ? "symlink"
              : "special";
      if (entryPath.endsWith("/koed-server-package-manifest.json")) {
        manifestBytes = size;
      }
      current = {
        type,
        path: entryPath,
        size,
        remaining: size,
        padding,
        hash: type === "file" ? createHash("sha256") : undefined,
        scan:
          type === "file" &&
          size <= 16 * 1024 * 1024 &&
          textPattern.test(entryPath),
        leak: false,
        chunks: []
      };
    }
    if (ended) break;
  }
  if (current || !ended) throw new Error("Truncated tar archive");
  return collector.finish({
    source: archive,
    archiveBytes: statSync(archive).size,
    manifestBytes
  });
};

export const evaluateArtifactPolicy = (report, policy, baseline = null) => {
  const errors = [];
  if (report.bytes.duplicateRatio > policy.maxDuplicateRatio) {
    errors.push(
      `duplicate ratio ${report.bytes.duplicateRatio} exceeds ${policy.maxDuplicateRatio}`
    );
  }
  if (
    report.bytes.manifest !== null &&
    report.bytes.manifest > policy.maxManifestBytes
  ) {
    errors.push(
      `manifest bytes ${report.bytes.manifest} exceeds ${policy.maxManifestBytes}`
    );
  }
  for (const key of [
    "symlinks",
    "specialFiles",
    "foreignPlatformNativeFiles",
    "absolutePaths",
    "sourceCheckoutLeaks"
  ]) {
    if (report.findings[key].length > 0) {
      errors.push(`${key}: ${report.findings[key].join(", ")}`);
    }
  }
  if (
    baseline &&
    report.bytes.archive !== null &&
    report.source.startsWith("koed-native-runtime-linux-x64-")
  ) {
    const baselineBytes =
      baseline.artifacts?.["koed-native-runtime-linux-x64-0.6.2.tar.gz"];
    if (
      typeof baselineBytes === "number" &&
      report.bytes.archive >
        baselineBytes * (1 + policy.nativeRuntimeGrowthMaximum)
    ) {
      errors.push(
        `native runtime archive bytes ${report.bytes.archive} exceed the v0.6.2 growth gate ${Math.floor(baselineBytes * (1 + policy.nativeRuntimeGrowthMaximum))}`
      );
    }
  }
  if (
    baseline &&
    report.bytes.archive !== null &&
    report.source.startsWith("koed-server-")
  ) {
    const baselineName =
      report.target.platform === "macos" &&
      report.target.architecture === "arm64"
        ? "koed-server-0.6.2-macos-arm64.tar.gz"
        : report.target.platform === "linux" &&
            report.target.architecture === "x64"
          ? "koed-server-0.6.2-linux-x64.tar.gz"
          : null;
    const baselineBytes = baselineName
      ? baseline.artifacts?.[baselineName]
      : undefined;
    if (
      typeof baselineBytes === "number" &&
      report.bytes.archive >
        baselineBytes * (1 - policy.standaloneReductionMinimum)
    ) {
      errors.push(
        `standalone archive bytes ${report.bytes.archive} do not meet the v0.6.2 reduction gate ${Math.floor(baselineBytes * (1 - policy.standaloneReductionMinimum))}`
      );
    }
  }
  return { ok: errors.length === 0, errors };
};

export const formatArtifactReport = (report) =>
  [
    `Artifact: ${report.source} (${report.target.platform}/${report.target.architecture})`,
    `Expanded: ${report.bytes.expandedRegularFiles} bytes; unique: ${report.bytes.uniqueContent} bytes; duplicate ratio: ${(report.bytes.duplicateRatio * 100).toFixed(2)}%`,
    `Entries: ${report.entryCounts.file} files, ${report.entryCounts.directory} directories, ${report.entryCounts.symlink} symlinks, ${report.entryCounts.special} special`,
    "Largest contributors:",
    ...report.largestContributors.map(
      (entry) => `  ${entry.name}: ${entry.bytes} bytes`
    ),
    ...(report.nativeRuntimeComponents.length > 0
      ? [
          "Native runtime components (compressed values are proportional estimates for the solid gzip archive):",
          ...report.nativeRuntimeComponents.map(
            (entry) =>
              `  ${entry.name}: ${entry.expandedBytes} expanded; ${entry.estimatedCompressedBytes ?? "n/a"} estimated compressed bytes`
          )
        ]
      : [])
  ].join("\n");

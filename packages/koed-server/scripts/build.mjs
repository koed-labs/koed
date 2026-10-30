import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const pruneOutputs = (directory, emitted) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      pruneOutputs(path, emitted);
      if (readdirSync(path).length === 0) rmSync(path, { recursive: true });
    } else if (!emitted.has(path)) rmSync(path);
  }
};

export const buildKoedServer = (packageRoot) => {
  const configPath = resolve(packageRoot, "tsconfig.json");
  const dist = resolve(packageRoot, "dist");
  const buildInfo = resolve(packageRoot, "tsconfig.tsbuildinfo");
  const report = ts.createDiagnosticReporter(ts.sys, true);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    report(config.error);
    throw new Error("Cannot read the Server TypeScript configuration.");
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    packageRoot,
    undefined,
    configPath
  );
  if (parsed.errors.length > 0) {
    parsed.errors.forEach(report);
    throw new Error("Invalid Server TypeScript configuration.");
  }
  if (parsed.options.outDir !== dist)
    throw new Error("The Server build requires its configured dist directory.");

  const scratch = resolve(packageRoot, "../../scratch");
  mkdirSync(scratch, { recursive: true });
  const staging = mkdtempSync(resolve(scratch, "server-build-"));
  const outputs = new Map();
  try {
    const host = ts.createSolutionBuilderHost(ts.sys, undefined, report);
    const readFile = host.readFile;
    const writeFile = host.writeFile;
    // A failed compile must not update the live build state or its outputs.
    host.readFile = (path) =>
      resolve(path) === buildInfo ? undefined : readFile(path);
    host.writeFile = (path, contents, ...args) => {
      const destination = resolve(path);
      if (
        destination === buildInfo ||
        destination.startsWith(`${dist}${sep}`)
      ) {
        const staged = resolve(staging, relative(packageRoot, destination));
        mkdirSync(dirname(staged), { recursive: true });
        writeFile(staged, contents, ...args);
        outputs.set(destination, staged);
      } else writeFile(path, contents, ...args);
    };
    const code = ts
      .createSolutionBuilder(host, [configPath], { force: true })
      .build();
    if (code !== 0)
      throw new Error(`Server compilation failed with exit code ${code}.`);

    // Keep the compiler's logical output paths so declaration maps stay valid.
    // Check every expected output, not just the executable's existence.
    for (const source of parsed.fileNames) {
      for (const output of ts.getOutputFileNames(
        parsed,
        source,
        !ts.sys.useCaseSensitiveFileNames
      )) {
        if (!outputs.has(resolve(output)))
          throw new Error(
            `Server compilation did not emit ${relative(packageRoot, output)}.`
          );
      }
    }
    const modules = resolve(packageRoot, "node_modules");
    copyFileSync(
      resolve(packageRoot, "package.json"),
      resolve(staging, "package.json")
    );
    if (existsSync(modules))
      symlinkSync(modules, resolve(staging, "node_modules"), "junction");
    const help = spawnSync(
      process.execPath,
      [resolve(staging, "dist/cli.js"), "--help"],
      { encoding: "utf8", timeout: 30_000 }
    );
    if (help.error) throw help.error;
    if (help.status !== 0 || !help.stdout.includes("Usage: koed"))
      throw new Error(
        `The compiled Server CLI failed its help check: ${help.stderr}`
      );

    const emitted = new Set(
      [...outputs.keys()].filter((path) => path !== buildInfo)
    );
    const publish = (destination) => {
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(outputs.get(destination), destination);
    };
    // Publish new dependencies first. Retain obsolete modules until every new
    // output is present, so interruption never leaves imports to absent files.
    for (const path of emitted) if (!existsSync(path)) publish(path);
    for (const path of emitted)
      if (existsSync(outputs.get(path))) publish(path);
    pruneOutputs(dist, emitted);
    if (outputs.has(buildInfo)) publish(buildInfo);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  buildKoedServer(resolve(import.meta.dirname, ".."));

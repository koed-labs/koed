import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildKoedServer } from "../packages/koed-server/scripts/build.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const write = (root, path, contents) => {
  const destination = resolve(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
};
const fixture = () => {
  const scratch = resolve(import.meta.dirname, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(resolve(scratch, "server-build-test-"));
  roots.push(root);
  const server = resolve(root, "packages/koed-server");
  write(server, "package.json", JSON.stringify({ type: "module" }));
  write(
    server,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        composite: true,
        declaration: true,
        declarationMap: true,
        target: "ES2022",
        module: "NodeNext",
        outDir: "dist",
        rootDir: "src",
        types: [],
        skipLibCheck: true
      },
      include: ["src/**/*.ts"]
    })
  );
  write(
    server,
    "src/cli.ts",
    'import { help } from "./legacy.js"; console.log(help);\n'
  );
  write(server, "src/legacy.ts", 'export const help = "Usage: koed old";\n');
  buildKoedServer(server);
  return { root, server };
};
const help = (server) => {
  const result = spawnSync(
    process.execPath,
    [resolve(server, "dist/cli.js"), "--help"],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const snapshot = (server) => {
  const dist = resolve(server, "dist");
  return Object.fromEntries(
    readdirSync(dist).map((name) => [
      name,
      readFileSync(resolve(dist, name), "utf8")
    ])
  );
};

test("a failed compile retains the previous executable, deleted-source dependencies, and build state", () => {
  const { server } = fixture();
  const previous = snapshot(server);
  const buildInfo = readFileSync(resolve(server, "tsconfig.tsbuildinfo"));
  rmSync(resolve(server, "src/legacy.ts"));
  write(
    server,
    "src/cli.ts",
    'import { help } from "./cli-command-tree.js"; console.log(help);\n'
  );
  write(server, "src/cli-command-tree.ts", "export const help: string = 42;\n");
  assert.throws(() => buildKoedServer(server), /Server compilation failed/);
  assert.deepEqual(snapshot(server), previous);
  assert.deepEqual(
    readFileSync(resolve(server, "tsconfig.tsbuildinfo")),
    buildInfo
  );
  assert.match(help(server), /Usage: koed old/);
});

test("a compiled CLI with a missing runtime import never replaces the working executable", () => {
  const { server } = fixture();
  const previous = snapshot(server);
  write(
    server,
    "src/cli.ts",
    'await import("./" + "absent.js"); console.log("Usage: koed broken");\n'
  );
  assert.throws(() => buildKoedServer(server), /failed its help check/);
  assert.deepEqual(snapshot(server), previous);
  assert.match(help(server), /Usage: koed old/);
});

test("a successful build publishes the new CLI and prunes obsolete outputs with valid declaration maps", () => {
  const { root, server } = fixture();
  rmSync(resolve(server, "src/legacy.ts"));
  write(
    server,
    "src/cli.ts",
    'import { help } from "./cli-command-tree.js"; console.log(help);\n'
  );
  write(
    server,
    "src/cli-command-tree.ts",
    'export { help } from "./nested/help.js";\n'
  );
  write(
    server,
    "src/nested/help.ts",
    'export const help = "Usage: koed new";\n'
  );
  buildKoedServer(server);
  assert.match(help(server), /Usage: koed new/);
  for (const suffix of ["js", "d.ts", "d.ts.map"])
    assert.equal(existsSync(resolve(server, `dist/legacy.${suffix}`)), false);
  const map = JSON.parse(
    readFileSync(resolve(server, "dist/nested/help.d.ts.map"), "utf8")
  );
  assert.equal(
    resolve(server, "dist/nested", map.sources[0]),
    resolve(server, "src/nested/help.ts")
  );
  assert.deepEqual(readdirSync(resolve(root, "scratch")), []);
});

test("killing the compiler during emission preserves every live CLI output", () => {
  const { server } = fixture();
  const previous = snapshot(server);
  write(
    server,
    "src/legacy.ts",
    'export const help = "Usage: koed interrupted";\n'
  );
  const builder = pathToFileURL(
    resolve(import.meta.dirname, "../packages/koed-server/scripts/build.mjs")
  ).href;
  const interrupted = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import ts from "typescript";
    import { buildKoedServer } from ${JSON.stringify(builder)};
    ts.sys.writeFile = () => process.kill(process.pid, "SIGKILL");
    buildKoedServer(${JSON.stringify(server)});
  `
    ],
    { encoding: "utf8" }
  );
  assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
  assert.deepEqual(snapshot(server), previous);
  assert.match(help(server), /Usage: koed old/);
});

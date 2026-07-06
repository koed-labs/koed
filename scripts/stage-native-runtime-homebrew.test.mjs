import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const script = resolve(
  repoRoot,
  "scripts",
  "stage-native-runtime-homebrew.mjs"
);
const temps = [];

const tempDir = (prefix) => {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

const writeExecutable = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
};

const makeFakeHomebrew = () => {
  const root = tempDir("koed-stage-homebrew-");
  const bin = resolve(root, "bin");
  const postgres = resolve(root, "opt", "postgresql@17");
  const pgvector = resolve(root, "opt", "pgvector");
  const llama = resolve(root, "opt", "llama.cpp");
  const sharedir = resolve(postgres, "share", "postgresql@17");
  const pkglibdir = resolve(postgres, "lib", "postgresql");

  mkdirSync(bin, { recursive: true });
  for (const name of ["pg_ctl", "psql"]) {
    writeExecutable(
      resolve(postgres, "bin", name),
      `#!/bin/sh\necho ${name}\n`
    );
  }
  writeExecutable(
    resolve(postgres, "bin", "initdb"),
    "#!/bin/sh\necho 'initdb (PostgreSQL) 17.6'\n"
  );
  writeExecutable(
    resolve(postgres, "bin", "pg_config"),
    `#!/bin/sh\nif [ "$1" = "--sharedir" ]; then echo '${sharedir}'; elif [ "$1" = "--pkglibdir" ]; then echo '${pkglibdir}'; else echo 'PostgreSQL 17.6'; fi\n`
  );
  mkdirSync(resolve(sharedir, "extension"), { recursive: true });
  writeFileSync(
    resolve(sharedir, "extension", "vector.control"),
    "comment = 'vector'\n"
  );
  writeFileSync(
    resolve(sharedir, "extension", "vector--0.8.0.sql"),
    "-- vector\n"
  );
  mkdirSync(pkglibdir, { recursive: true });
  writeFileSync(resolve(pkglibdir, "vector.so"), "vector shared library\n");
  writeExecutable(
    resolve(llama, "bin", "llama-server"),
    "#!/bin/sh\necho 'llama-server 1.0'\n"
  );
  mkdirSync(pgvector, { recursive: true });

  writeExecutable(
    resolve(bin, "brew"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'Homebrew fake'; exit 0; fi\nif [ "$1" = "--prefix" ]; then\n  case "$2" in\n    postgresql@17) echo '${postgres}' ;;\n    pgvector) echo '${pgvector}' ;;\n    llama.cpp) echo '${llama}' ;;\n    *) echo '${root}' ;;\n  esac\n  exit 0\nfi\necho unsupported >&2\nexit 1\n`
  );

  return { root, bin, postgres, llama, pgvector };
};

test.afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test("stages Homebrew runtime assets into KOED_NATIVE_RUNTIME_SOURCE_DIR layout", () => {
  const fake = makeFakeHomebrew();
  const out = tempDir("koed-native-runtime-out-");
  rmSync(out, { recursive: true, force: true });
  const embeddingVenv = resolve(tempDir("koed-embedding-venv-"), ".venv");
  mkdirSync(resolve(embeddingVenv, "bin"), { recursive: true });
  writeExecutable(
    resolve(embeddingVenv, "bin", "python"),
    "#!/bin/sh\necho python\n"
  );

  const result = spawnSync(process.execPath, [script, "--out", out, "--json"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${fake.bin}:${process.env.PATH ?? ""}`,
      KOED_EMBEDDING_VENV_DIR: embeddingVenv
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.provider, "homebrew");
  assert.equal(json.outDir, out);
  assert.ok(existsSync(resolve(out, "postgres", "bin", "initdb")));
  assert.ok(existsSync(resolve(out, "postgres", "bin", "pg_ctl")));
  assert.ok(existsSync(resolve(out, "postgres", "bin", "psql")));
  assert.ok(existsSync(resolve(out, "postgres", "bin", "pg_config")));
  assert.ok(
    existsSync(
      resolve(
        out,
        "postgres",
        "share",
        "postgresql@17",
        "extension",
        "vector.control"
      )
    )
  );
  assert.ok(
    existsSync(
      resolve(
        out,
        "postgres",
        "share",
        "postgresql@17",
        "extension",
        "vector--0.8.0.sql"
      )
    )
  );
  assert.ok(
    existsSync(resolve(out, "postgres", "lib", "postgresql", "vector.so"))
  );
  assert.ok(existsSync(resolve(out, "llama.cpp", "llama-server")));
  assert.ok(
    existsSync(resolve(out, "embedding-service", ".venv", "bin", "python"))
  );
  assert.match(
    readFileSync(resolve(out, "README.koed-native-runtime.txt"), "utf8"),
    /local packaged smoke testing/
  );
});

test("fails clearly when embedding-service venv is missing", () => {
  const fake = makeFakeHomebrew();
  const out = tempDir("koed-native-runtime-out-");
  rmSync(out, { recursive: true, force: true });
  const missingVenv = resolve(tempDir("koed-missing-embedding-venv-"), ".venv");

  const result = spawnSync(process.execPath, [script, "--out", out], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${fake.bin}:${process.env.PATH ?? ""}`,
      KOED_EMBEDDING_VENV_DIR: missingVenv
    },
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing Embedding Service Python runtime/);
});

test("refuses to replace a non-empty output directory without --force", () => {
  const fake = makeFakeHomebrew();
  const out = tempDir("koed-native-runtime-out-");
  writeFileSync(resolve(out, "existing"), "do not replace");

  const result = spawnSync(process.execPath, [script, "--out", out], {
    cwd: repoRoot,
    env: { ...process.env, PATH: `${fake.bin}:${process.env.PATH ?? ""}` },
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Output directory is not empty/);
});

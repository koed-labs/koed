import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  coreInventory,
  coreRecipeId,
  freezeCore,
  packageFrozenCore,
  verifyFrozenCore
} from "./core-artifact.mjs";

const roots = [];
test.afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
);
const fixture = () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch", "core-artifact-"));
  roots.push(root);
  const runtimeRoot = resolve(root, "koed-runtime");
  for (const path of [
    "postgres/bin/postgres",
    "postgres/bin/initdb",
    "postgres/bin/pg_ctl",
    "postgres/bin/psql",
    "postgres/bin/pg_dump",
    "postgres/bin/pg_restore",
    "postgres/lib/vector.so",
    "postgres/lib/pgcrypto.so",
    "llama.cpp/llama-server",
    "llama.cpp/cpu/llama-server",
    "llama.cpp/cpu/libllama.so.1"
  ]) {
    const target = resolve(runtimeRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `fixture ${path}\n`, {
      mode:
        path.includes("/bin/") || path.endsWith("llama-server") ? 0o755 : 0o644
    });
  }
  symlinkSync(
    "libllama.so.1",
    resolve(runtimeRoot, "llama.cpp/cpu/libllama.so")
  );
  const configuration = JSON.parse(
    readFileSync(new URL("./core.linux-x64.json", import.meta.url), "utf8")
  );
  const pinned = JSON.parse(
    readFileSync(new URL("./sources.linux-x64.json", import.meta.url), "utf8")
  );
  const recipe = {
    schemaVersion: 1,
    kind: "core",
    configuration,
    sources: Object.fromEntries(
      ["postgres", "pgvector", "llamaCpp"].map((key) => [key, pinned[key]])
    ),
    toolchain: { cc: "fixture" },
    logic: { build: "a".repeat(64) },
    packaging: { epoch: 0 }
  };
  freezeCore({ runtimeRoot, configuration, recipe });
  return { root, runtimeRoot, recipe };
};

test("frozen core repackaging preserves bytes across output paths and product versions", () => {
  const { root, runtimeRoot } = fixture();
  const secondRoot = resolve(root, "relocated");
  cpSync(runtimeRoot, secondRoot, { recursive: true, verbatimSymlinks: true });
  const out1 = resolve(root, "one"),
    out2 = resolve(root, "two");
  mkdirSync(out1);
  mkdirSync(out2);
  const before = process.env.KOED_NATIVE_RUNTIME_VERSION;
  try {
    process.env.KOED_NATIVE_RUNTIME_VERSION = "0.10.3";
    const first = packageFrozenCore({ runtimeRoot, outDir: out1 });
    process.env.KOED_NATIVE_RUNTIME_VERSION = "99.0.0";
    const second = packageFrozenCore({ runtimeRoot: secondRoot, outDir: out2 });
    assert.deepEqual(first, second);
    assert.deepEqual(
      readFileSync(resolve(out1, first.archive)),
      readFileSync(resolve(out2, second.archive))
    );
    assert.throws(
      () => packageFrozenCore({ runtimeRoot, outDir: out1 }),
      /overwrite/
    );
  } finally {
    if (before === undefined) delete process.env.KOED_NATIVE_RUNTIME_VERSION;
    else process.env.KOED_NATIVE_RUNTIME_VERSION = before;
  }
});

test("recipe identity covers source, toolchain, build logic and packaging inputs", () => {
  const { recipe } = fixture();
  const original = coreRecipeId(recipe);
  for (const mutate of [
    (value) => {
      value.sources.postgres.sha256 = "b".repeat(64);
    },
    (value) => {
      value.toolchain.cc = "different compiler";
    },
    (value) => {
      value.logic.build = "c".repeat(64);
    },
    (value) => {
      value.packaging.epoch = 1;
    }
  ]) {
    const changed = structuredClone(recipe);
    mutate(changed);
    assert.notEqual(coreRecipeId(changed), original);
  }
});

for (const change of [
  "bytes",
  "mode",
  "link",
  "extra",
  "cuda",
  "special-mode"
]) {
  test(`frozen inventory rejects changed ${change}`, () => {
    const { runtimeRoot } = fixture();
    const target = resolve(runtimeRoot, "llama.cpp/cpu/llama-server");
    if (change === "bytes") writeFileSync(target, "changed");
    if (change === "mode") chmodSync(target, 0o644);
    if (change === "special-mode") chmodSync(target, 0o4755);
    if (change === "extra")
      writeFileSync(resolve(runtimeRoot, "postgres/extra"), "extra");
    if (change === "cuda") mkdirSync(resolve(runtimeRoot, "llama.cpp/cuda"));
    if (change === "link") {
      rmSync(resolve(runtimeRoot, "llama.cpp/cpu/libllama.so"));
      symlinkSync(
        "llama-server",
        resolve(runtimeRoot, "llama.cpp/cpu/libllama.so")
      );
    }
    assert.throws(
      () => verifyFrozenCore(runtimeRoot),
      /changed|unexpected|permission/
    );
  });
}

test("inventory mismatch reports bounded paths and changed fields without file contents", () => {
  const { runtimeRoot } = fixture();
  writeFileSync(
    resolve(runtimeRoot, "llama.cpp/cpu/llama-server"),
    "secret changed content"
  );
  rmSync(resolve(runtimeRoot, "postgres/bin/pg_dump"));
  for (let i = 0; i < 20; i++)
    writeFileSync(
      resolve(runtimeRoot, `postgres/extra-${String(i).padStart(2, "0")}`),
      "extra"
    );
  assert.throws(
    () => verifyFrozenCore(runtimeRoot),
    (error) => {
      assert.match(
        error.message,
        /llama\.cpp\/cpu\/llama-server.*(?:bytes|sha256)/
      );
      assert.match(error.message, /postgres\/bin\/pg_dump.*missing/);
      assert.match(error.message, /postgres\/extra-00.*unexpected/);
      assert.match(error.message, /truncated/);
      assert.doesNotMatch(
        error.message,
        /secret changed content|postgres\/extra-19/
      );
      assert.ok(error.message.length < 4096);
      return true;
    }
  );
});

test("truncation is reported only when more than ten differences exist", () => {
  const { runtimeRoot } = fixture();
  for (let i = 0; i < 10; i++)
    writeFileSync(resolve(runtimeRoot, `postgres/extra-${i}`), "extra");
  assert.throws(
    () => verifyFrozenCore(runtimeRoot),
    (error) => {
      assert.doesNotMatch(error.message, /truncated/);
      return true;
    }
  );
  writeFileSync(resolve(runtimeRoot, "postgres/extra-10"), "extra");
  assert.throws(() => verifyFrozenCore(runtimeRoot), /diagnostics truncated/);
});

test("CI verification blocks save when validation changes the core", () => {
  for (const mutate of [false, true]) {
    const { root, runtimeRoot } = fixture();
    const temp = resolve(root, "runner");
    mkdirSync(resolve(temp, "koed-native-core"), { recursive: true });
    cpSync(runtimeRoot, resolve(temp, "koed-native-core/koed-runtime"), {
      recursive: true,
      verbatimSymlinks: true
    });
    const bin = resolve(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      resolve(bin, "pnpm"),
      `#!/bin/sh\n${mutate ? 'printf changed > "$RUNNER_TEMP/koed-native-core/koed-runtime/postgres/bin/postgres"' : ":"}\n`,
      { mode: 0o755 }
    );
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const step = workflow
      .split("- name: Verify Linux native CPU core\n")[1]
      .split("\n      - name:")[0];
    const script = step.split("        run: |\n")[1].replace(/^ {10}/gm, "");
    const marker = resolve(root, "saved");
    const result = spawnSync(
      "bash",
      ["-c", `${script}\nprintf saved > "$SAVE_MARKER"`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          RUNNER_TEMP: temp,
          SAVE_MARKER: marker,
          PATH: `${bin}:${process.env.PATH}`
        }
      }
    );
    assert.equal(result.status, mutate ? 1 : 0, result.stderr);
    assert.equal(existsSync(marker), !mutate);
    if (mutate)
      assert.match(
        result.stderr,
        /Native core inventory changed after freezing/
      );
  }
});

test("inventory diagnostic remains bounded for escaped filenames", () => {
  const { runtimeRoot } = fixture();
  for (let i = 0; i < 10; i++)
    writeFileSync(
      resolve(runtimeRoot, `postgres/${i}${"\x01".repeat(110)}`),
      "extra"
    );
  assert.throws(
    () => verifyFrozenCore(runtimeRoot),
    (error) => {
      assert.ok(
        error.message.length < 4096,
        `diagnostic length: ${error.message.length}`
      );
      return true;
    }
  );
});

test("native inventory rejects hard links, absolute links and link chains", () => {
  const { runtimeRoot } = fixture();
  const target = resolve(runtimeRoot, "llama.cpp/cpu/second-link");
  linkSync(resolve(runtimeRoot, "llama.cpp/cpu/llama-server"), target);
  assert.throws(() => coreInventory(runtimeRoot), /hard links/);
  rmSync(target);
  symlinkSync(resolve(runtimeRoot, "llama.cpp/cpu/libllama.so.1"), target);
  assert.throws(() => coreInventory(runtimeRoot), /contained regular file/);
  rmSync(target);
  symlinkSync("libllama.so", target);
  assert.throws(() => coreInventory(runtimeRoot), /contained regular file/);
});

test("core packaging enforces both size budgets", () => {
  const { runtimeRoot, root } = fixture();
  const out = resolve(root, "out");
  mkdirSync(out);
  assert.throws(
    () => packageFrozenCore({ runtimeRoot, outDir: out, maxExpandedBytes: 1 }),
    /budget/
  );
  assert.throws(
    () => packageFrozenCore({ runtimeRoot, outDir: out, maxArchiveBytes: 1 }),
    /budget/
  );
});

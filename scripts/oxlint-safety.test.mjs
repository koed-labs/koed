import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const samples = {
  "await-thenable": "export async function f() { await 1; }",
  "no-floating-promises": "Promise.resolve(1); export {};",
  "no-misused-promises":
    "export function f() { [1].forEach(async () => { await Promise.resolve(); }); }",
  "no-unsafe-argument":
    "declare const value: any; function takes(x: string) { return x; } export const result = takes(value);",
  "no-unsafe-assignment":
    "declare const value: any; export const result: string = value;",
  "no-unsafe-member-access":
    "declare const value: any; export const result = value.foo;",
  "no-unsafe-return":
    "declare const value: any; export function f(): string { return value; }",
  "no-base-to-string": "export const result = String({});",
  "prefer-promise-reject-errors":
    'Promise.reject("bad").catch(() => {}); export {};',
  "require-await": "export async function f() { return 1; }"
};
const common = [
  "await-thenable",
  "no-floating-promises",
  "no-misused-promises"
];
const unsafe = [
  "no-unsafe-argument",
  "no-unsafe-assignment",
  "no-unsafe-member-access",
  "no-unsafe-return"
];
const scopes = [
  {
    prefix: "apps/api/src/probes/",
    suffix: ".ts",
    rules: Object.keys(samples)
  },
  {
    prefix: "packages/shared/src/probes/",
    suffix: ".test.ts",
    rules: [...common, ...unsafe]
  },
  { prefix: "apps/api/src/probes/", suffix: ".test.ts", rules: common },
  {
    prefix: "apps/api/src/browser-approval/probes/",
    suffix: ".tsx",
    rules: common
  },
  { prefix: "probe-", suffix: ".config.ts", rules: common }
];

test("Oxlint preserves typed scopes, suppressions, and native optional-chain checks", () => {
  const scratch = path.join(root, "scratch");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(path.join(scratch, "oxlint-safety-"));
  const cases = [];
  const add = (file, source, rule, expected) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), source + "\n");
    cases.push({ file, rule, expected });
  };
  try {
    assert.equal(spawnSync("git", ["init", "--quiet", dir]).status, 0);
    const config = JSON.parse(
      readFileSync(path.join(root, ".oxlintrc.json"), "utf8")
    );
    writeFileSync(path.join(dir, ".oxlintrc.json"), JSON.stringify(config));
    writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "NodeNext",
          jsx: "react-jsx",
          types: []
        },
        include: ["**/*.ts", "**/*.tsx"]
      })
    );
    for (const scope of scopes) {
      for (const [rule, source] of Object.entries(samples)) {
        for (const suppressed of [false, true]) {
          add(
            scope.prefix +
              rule +
              (suppressed ? "-suppressed" : "-failing") +
              scope.suffix,
            (suppressed
              ? `/* eslint-disable @typescript-eslint/${rule} */\n`
              : "") + source,
            `typescript(${rule})`,
            scope.rules.includes(rule) && !suppressed
          );
        }
      }
    }
    for (const suppressed of [false, true]) {
      add(
        "packages/shared/src/probes/optional" +
          (suppressed ? "-suppressed" : "") +
          ".ts",
        (suppressed
          ? "/* eslint-disable no-unsafe-optional-chaining */\n"
          : "") +
          "declare const x: {value:()=>void}|undefined; (x?.value as () => void)();",
        "eslint(no-unsafe-optional-chaining)",
        !suppressed
      );
    }
    add(
      "apps/api/src/probes/finally.ts",
      [
        "declare const processing: Promise<void>; declare const close: () => Promise<void>;",
        "void processing",
        "// oxlint-disable-next-line typescript/no-misused-promises -- Promise.finally awaits the cleanup promise.",
        ".finally(() => close()).catch(() => undefined);"
      ].join("\n"),
      "typescript(no-misused-promises)",
      false
    );
    add(
      "apps/api/src/probes/unsafe-callback.ts",
      "declare function f(callback: () => void): void; declare const close: () => Promise<void>; f(() => close());",
      "typescript(no-misused-promises)",
      true
    );
    const result = spawnSync(
      path.join(root, "node_modules/.bin/oxlint"),
      ["-c", path.join(dir, ".oxlintrc.json"), "--format", "json", "."],
      { cwd: dir, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.number_of_files, cases.length);
    for (const c of cases) {
      const found = data.diagnostics.some(
        (d) => d.filename === c.file && d.code === c.rule
      );
      assert.equal(found, c.expected, `${c.file}: ${c.rule}`);
    }
    assert.equal(cases.length, 104);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tracked JavaScript uses .mjs so parser strict-mode checks apply", () => {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--", "*.js", "*.jsx", "*.cjs"],
    {
      cwd: root,
      encoding: "utf8"
    }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stdout.split("\0").filter(Boolean),
    [],
    "Use .mjs for JavaScript and .tsx for JSX, or explicitly review and replace the retired syntax checks."
  );
});

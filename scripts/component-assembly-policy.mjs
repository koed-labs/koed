import { existsSync } from "node:fs";
import { resolve } from "node:path";

const hasClosureOwnedOptionalNativePackage = (closure) => {
  const addon = closure.find(
    ({ manifest }) => manifest.name === "msgpackr-extract"
  );
  if (!addon) return false;
  const declared = Object.keys(
    addon.manifest.optionalDependencies ?? {}
  ).filter((name) => name.startsWith("@msgpackr-extract/msgpackr-extract-"));
  return declared.some((name) =>
    closure.some((entry) => entry.manifest.name === name)
  );
};

export const sourceAuditExclusion = (packageName, file) => {
  if (
    [
      "@fastify/cookie",
      "fastify-plugin",
      "@fastify/cors",
      "@fastify/websocket",
      "fastify",
      "@fastify/ajv-compiler",
      "fast-uri",
      "@fastify/error",
      "@fastify/fast-json-stringify-compiler",
      "fast-json-stringify",
      "@fastify/merge-json-schemas",
      "json-schema-ref-resolver",
      "@fastify/proxy-addr",
      "avvio",
      "fastq",
      "reusify",
      "safe-regex2",
      "light-my-request",
      "process-warning",
      "pino",
      "@pinojs/redact",
      "pino-std-serializers",
      "thread-stream",
      "secure-json-parse",
      "qs",
      "es-define-property",
      "side-channel",
      "es-errors",
      "object-inspect",
      "side-channel-list",
      "side-channel-map",
      "call-bound",
      "call-bind-apply-helpers",
      "function-bind",
      "get-intrinsic",
      "es-object-atoms",
      "get-proto",
      "dunder-proto",
      "gopd",
      "has-symbols",
      "hasown",
      "globalthis",
      "define-data-property",
      "has-property-descriptors",
      "object-keys",
      "json-stringify-safe",
      "semver-compare"
    ].includes(packageName) &&
    /^eslint\.config\.[cm]?js$/.test(file)
  )
    return "package-local ESLint configuration, not a runtime entrypoint";
  if (
    [
      ["pg-types", "test/index.js"],
      ["isexe", "test/basic.js"],
      ["fastify", "test/build-certificate.js"],
      ["fastify", "test/input-validation.js"],
      ["fastify", "examples/parser.js"],
      ["fastq", "test/promise.js"],
      ["rfdc", "test/index.js"],
      ["node-abort-controller", "__tests__/node-fetch.js"],
      ["node-abort-controller", "__tests__/whatwg-fetch.js"],
      ["pino", "test/fixtures/syntax-error-esm.mjs"],
      ["pino", "test/fixtures/ts/transpile.cjs"],
      ["pino", "test/helper.js"],
      ["sonic-boom", "test/helper.js"],
      ["thread-stream", "test/syntax-error.mjs"],
      ["qs", "test/parse.js"],
      ["duplexify", "test.js"],
      ["stream-shift", "test.js"],
      ["xtend", "test.js"],
      ["split2", "test.js"],
      ["node-gyp-build", "build-test.js"],
      ["node-gyp-build-optional-packages", "build-test.js"],
      ["msgpackr", "dist/test.js"],
      ["pg-protocol", "dist/inbound-parser.test.js"],
      ["pg-protocol", "dist/outbound-serializer.test.js"],
      ["@fastify/cookie", "benchmark/signer-multi.js"],
      ["@fastify/cookie", "benchmark/signer.js"],
      ["@fastify/cors", "benchmark/vary.js"],
      ["fastify", "examples/benchmark/parser.js"],
      ["@fastify/ajv-compiler", "benchmark/small-object.mjs"],
      ["fast-uri", "benchmark/benchmark.mjs"],
      ["fast-uri", "benchmark/equal.mjs"],
      ["fast-uri", "benchmark/non-simple-domain.mjs"],
      ["fast-uri", "benchmark/string-array-to-hex-stripped.mjs"],
      ["fast-uri", "benchmark/ws-is-secure.mjs"],
      ["@fastify/error", "benchmarks/create.js"],
      ["@fastify/error", "benchmarks/instantiate.js"],
      ["@fastify/error", "benchmarks/no-stack.js"],
      ["@fastify/error", "benchmarks/toString.js"],
      ["fast-json-stringify", "benchmark/bench-cmp-branch.js"],
      ["fastq", "bench.js"],
      ["reusify", "test.js"],
      ["find-my-way", "benchmark/bench-thread.js"],
      ["find-my-way", "benchmark/compare-branches.js"],
      ["find-my-way", "benchmark/uri-decoding.js"],
      ["@fastify/proxy-addr", "benchmark/compiling.js"],
      ["@fastify/proxy-addr", "benchmark/kind.js"],
      ["@fastify/proxy-addr", "benchmark/matching.js"],
      ["fast-decode-uri-component", "bench.js"],
      ["fast-decode-uri-component", "test.js"],
      ["light-my-request", "benchmark/benchmark.js"],
      ["process-warning", "benchmarks/warn.js"],
      ["pino", "benchmarks/basic.bench.js"],
      ["pino", "benchmarks/child-child.bench.js"],
      ["pino", "benchmarks/child-creation.bench.js"],
      ["pino", "benchmarks/child.bench.js"],
      ["@pinojs/redact", "benchmarks/basic.js"],
      ["quick-format-unescaped", "benchmark.js"],
      ["sonic-boom", "bench.js"],
      ["thread-stream", "bench.js"],
      ["atomic-sleep", "test.js"],
      ["node-pty", "lib/windowsTerminal.test.js"],
      ["@stablelib/base64", "lib/base64.bench.js"],
      ["object-inspect", "test-core-js.js"]
    ].some(([name, path]) => packageName === name && file === path) ||
    ([
      "qs",
      "object-inspect",
      "es-define-property",
      "side-channel",
      "es-errors",
      "side-channel-list",
      "side-channel-map",
      "call-bound",
      "call-bind-apply-helpers",
      "function-bind",
      "get-intrinsic",
      "es-object-atoms",
      "get-proto",
      "dunder-proto",
      "gopd",
      "has-symbols",
      "math-intrinsics",
      "side-channel-weakmap",
      "retry",
      "globalthis",
      "define-data-property",
      "has-property-descriptors",
      "object-keys",
      "json-stringify-safe",
      "semver-compare",
      "@fastify/cookie",
      "fastify-plugin",
      "@fastify/cors",
      "fastify",
      "@fastify/ajv-compiler",
      "fast-uri",
      "@fastify/fast-json-stringify-compiler",
      "fast-json-stringify",
      "fastq",
      "find-my-way",
      "light-my-request",
      "process-warning",
      "pino",
      "@pinojs/redact",
      "on-exit-leak-free",
      "pino-abstract-transport",
      "pino-std-serializers",
      "sonic-boom",
      "thread-stream",
      "atomic-sleep",
      "secure-json-parse",
      "object-inspect"
    ].includes(packageName) &&
      file.startsWith("test/")) ||
    (packageName === "secure-json-parse" && file.startsWith("benchmarks/")) ||
    ([
      "fast-uri",
      "fast-json-stringify",
      "@fastify/proxy-addr",
      "find-my-way",
      "light-my-request"
    ].includes(packageName) &&
      file.startsWith("benchmark/")) ||
    (packageName === "process-warning" && file.startsWith("benchmarks/")) ||
    (["pino", "@pinojs/redact"].includes(packageName) &&
      file.startsWith("benchmarks/")) ||
    (packageName === "@fastify/error" && file.startsWith("benchmarks/"))
  )
    return "package test, example, or benchmark fixture, not a runtime entrypoint";
  if (
    packageName === "json-schema-to-ts" &&
    /^(?:lib\/esm|lib\/types)\//.test(file)
  )
    return "type-level JSON Schema utility distribution; no runtime module consumers in component graph";
  if (packageName === "bullmq" && file.startsWith("dist/esm/"))
    return "BullMQ package has no exports map; Node main selects dist/cjs/index.js, while dist/esm is bundler-only module output";
  if (packageName === "json-canonicalize" && /^(?:esm5|esm2015)\//.test(file))
    return "unselected bundler module entrypoint; Node main selects bundles";
  if (packageName === "ts-algebra" && file.startsWith("lib/"))
    return "type-level library entrypoint; no Node runtime consumers in component graph";
  if (packageName === "safer-buffer" && file === "tests.js")
    return "test-entrypoint";
  if (
    packageName === "@anthropic-ai/claude-agent-sdk" &&
    file === "browser-sdk.js"
  )
    return "non-node-browser-sdk-bundle";
  if (packageName === "global-agent" && file.startsWith("src/"))
    return "uncompiled-flow-source-not-package-entrypoint";
  if (
    packageName === "drizzle-orm" &&
    /^(?:bun-sql|bun-sqlite|expo-sqlite|op-sqlite)\//.test(file)
  )
    return "non-node-platform-entrypoint";
  if (packageName === "pg-cloudflare" && file === "dist/index.js")
    return "cloudflare-platform-entrypoint";
  if (packageName === "split2" && file === "bench.js")
    return "benchmark-entrypoint";
  if (packageName === "node-addon-api" && file.startsWith("tools/"))
    return "build-tooling";
  if (
    ["node-gyp-build", "node-gyp-build-optional-packages"].includes(
      packageName
    ) &&
    file === "bin.js"
  )
    return "build-cli-entrypoint";
  if (packageName === "semver" && file === "bin/semver.js")
    return "cli-entrypoint";
  if (packageName === "msgpackr" && file === "rollup.config.js")
    return "build-tooling";
  if (
    packageName === "@huggingface/transformers" &&
    [
      "dist/transformers.js",
      "dist/transformers.min.js",
      "dist/transformers.web.js",
      "dist/transformers.web.min.js",
      "dist/transformers.node.min.mjs",
      "dist/ort-wasm-simd-threaded.jsep.mjs"
    ].includes(file)
  )
    return "non-selected-transformers-runtime-target";
  if (
    packageName === "onnxruntime-node" &&
    ["script/build.js", "script/prepack.js"].includes(file)
  )
    return "native-addon-build-tooling";
  if (packageName === "sharp" && file.startsWith("install/"))
    return "native-addon-install-tooling";
  if (packageName === "@koed/mcp-server" && file.startsWith("integrations/pi/"))
    return "external-pi-integration";
  return null;
};

// Each exception owns its matching, prerequisite and emitted inventory policy here.
const policies = {
  "optional-native-platform-package-probe": {
    owner: "optional-native-platform-package-probe",
    ...{
      rationale:
        "node-gyp-build-optional-packages derives one platform/architecture package name and resolves it as an optional native prebuild fallback.",
      limit:
        "The selected @msgpackr-extract package is accepted only when msgpackr-extract declares it optional and closure includes a declared platform package; other computed targets remain unresolved."
    },
    requiresClosure: hasClosureOwnedOptionalNativePackage,
    missingClosure: "no declared msgpackr-extract platform package in closure"
  },
  "pino-caller-selected-transport-resolver": {
    owner: "pino-caller-selected-transport-resolver",
    ...{
      rationale:
        "Pino resolves configured transport origins relative to caller paths with createRequire(context). No transport is configured by Koed logger; target is caller-owned, not bundled.",
      limit:
        "If Koed configures a Pino transport, its selected target must be separately declared and verified in component closure before use. This owner does not include arbitrary caller targets."
    }
  },
  "claude-sdk-optional-platform-cli-probe": {
    owner: "claude-sdk-optional-platform-cli-probe",
    ...{
      rationale:
        "Claude Agent SDK derives its own module-relative require and resolves only fixed platform/architecture CLI package candidates before existsSync checks.",
      limit:
        "Only sdk.mjs expressions IMe(yr) and Xr.resolve(mi) are owned. Platform CLI runtime packages are deliberately removed and asserted absent; arbitrary require targets remain unresolved."
    }
  },
  "excluded-test-file": { owner: "excluded-test-file" },
  "base-runtime-path": { owner: "base-runtime-path" },
  "declared-package-runtime": { owner: "declared-package-runtime" },
  "declared-native-loader-runtime-edge": {
    owner: "declared-native-loader-runtime-edge"
  },
  "optional-view-engine-runtime-edge": {
    owner: "optional-view-engine-runtime-edge"
  },
  "platform-selected-native-addon-loader": {
    owner: "platform-selected-native-addon-loader"
  },
  "optional-libvips-package-probes": {
    owner: "optional-libvips-package-probes"
  },
  "maintained-local-source-file-set": {
    owner: "maintained-local-source-file-set"
  },
  "bundled-commonjs-module-loader": { owner: "bundled-commonjs-module-loader" },
  "bundled-commonjs-loader-helper": { owner: "bundled-commonjs-loader-helper" },
  "optional-worker-module-import": { owner: "optional-worker-module-import" },
  "optional-platform-module": { owner: "optional-platform-module" },
  "declared-provider-dependency": { owner: "declared-provider-dependency" },
  "external-ai-client-sdk-path": { owner: "external-ai-client-sdk-path" },
  "selected-runtime-component-path": {
    owner: "selected-runtime-component-path"
  },
  "runtime-generated-standalone-requires": {
    owner: "runtime-generated-standalone-requires"
  },
  "optional-env-file-guarded-by-existsSync": {
    owner: "optional-env-file-guarded-by-existsSync"
  },
  "onnxruntime-web-optional-wasm-asset": {
    owner: "onnxruntime-web-optional-wasm-asset"
  },
  "non-node-runtime-import": { owner: "non-node-runtime-import" },
  "cloudflare-runtime-import": { owner: "cloudflare-runtime-import" },
  "optional-native-plugin-import": { owner: "optional-native-plugin-import" },
  "non-node-webgpu-provider-import": {
    owner: "non-node-webgpu-provider-import"
  },
  "optional-build-only-libvips-package": {
    owner: "optional-build-only-libvips-package"
  }
};
const dynamicRules = [
  {
    match: (packageName, file, edge) =>
      packageName === "@koed-labs/server" &&
      file === "dist/remote-mcp-client.js" &&
      edge.loader === "import" &&
      edge.argumentText === "pathToFileURL(entry).href",
    policy: {
      owner: "selected-mcp-runtime-contracts-path",
      requiresClosure: (closure) =>
        closure.some(
          ({ manifest, packageRoot }) =>
            manifest.name === "@koed/mcp-server" &&
            existsSync(resolve(packageRoot, "dist/runtime-contracts.js"))
        ),
      missingClosure:
        "MCP runtime-contracts entrypoint is absent from component closure"
    }
  },
  {
    match: (packageName, file, edge) =>
      packageName === "node-gyp-build-optional-packages" &&
      file === "node-gyp-build.js" &&
      edge.loader === "createRequire" &&
      edge.call === "createRequire" &&
      edge.argumentText === "url.pathToFileURL(path.join(dir, 'package.json'))",
    policy: policies["optional-native-platform-package-probe"]
  },
  {
    match: (packageName, file, edge) =>
      packageName === "node-gyp-build-optional-packages" &&
      file === "node-gyp-build.js" &&
      edge.loader === "require.resolve" &&
      edge.call ===
        "require('module').createRequire(url.pathToFileURL(path.join(dir, 'package.json'))).resolve" &&
      edge.argumentText === "platformPackage",
    policy: policies["optional-native-platform-package-probe"]
  },
  {
    match: (packageName, file, edge) =>
      packageName === "pino" &&
      file === "lib/transport.js" &&
      ((edge.loader === "createRequire" &&
        edge.call === "createRequire" &&
        edge.argumentText === "context") ||
        (edge.loader === "require.resolve" &&
          edge.call === "createRequire(context).resolve" &&
          edge.argumentText === "origin")),
    policy: policies["pino-caller-selected-transport-resolver"]
  },
  {
    match: (packageName, file, edge) =>
      packageName === "@anthropic-ai/claude-agent-sdk" &&
      file === "sdk.mjs" &&
      ((edge.loader === "createRequire" &&
        edge.call === "IMe" &&
        edge.argumentText === "yr") ||
        (edge.loader === "require.resolve" &&
          edge.call === "Xr.resolve" &&
          edge.argumentText === "mi")),
    policy: policies["claude-sdk-optional-platform-cli-probe"]
  },
  {
    match: (packageName, file) =>
      /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(file),
    policy: policies["excluded-test-file"]
  },
  {
    match: (packageName, file) =>
      packageName === "bullmq" && /classes\/child-processor\.js$/.test(file),
    policy: policies["base-runtime-path"]
  },
  {
    match: (packageName, file) =>
      packageName === "real-require" &&
      (file === "src/index.js" || file.endsWith("/src/index.js")),
    policy: policies["declared-package-runtime"]
  },
  {
    match: (packageName, file) =>
      packageName === "node-pty" && file === "lib/utils.js",
    policy: policies["declared-native-loader-runtime-edge"]
  },
  {
    match: (packageName, file) =>
      packageName === "express" && file === "lib/view.js",
    policy: policies["optional-view-engine-runtime-edge"]
  },
  {
    match: (packageName, file) =>
      packageName === "onnxruntime-node" && file === "dist/binding.js",
    policy: policies["platform-selected-native-addon-loader"]
  },
  {
    match: (packageName, file) =>
      packageName === "sharp" &&
      ["lib/sharp.js", "lib/utility.js"].includes(file),
    policy: policies["platform-selected-native-addon-loader"]
  },
  {
    match: (packageName, file) =>
      packageName === "sharp" && file === "lib/libvips.js",
    policy: policies["optional-libvips-package-probes"]
  },
  {
    match: (packageName, file) =>
      packageName === "@koed/privacy-service" &&
      file === "dist/validation-cache.js",
    policy: policies["maintained-local-source-file-set"]
  },
  {
    match: (packageName, file) => packageName === "qs" && file === "dist/qs.js",
    policy: policies["bundled-commonjs-module-loader"]
  },
  {
    match: (packageName, file, edge) =>
      packageName === "@huggingface/transformers" &&
      [
        "dist/transformers.node.cjs",
        "dist/transformers.node.min.cjs",
        "dist/transformers.node.mjs"
      ].includes(file) &&
      edge.loader === "require.apply" &&
      edge.call === "require.apply" &&
      edge.argumentText === "arguments",
    policy: policies["bundled-commonjs-loader-helper"]
  },
  {
    match: (packageName, file, edge) =>
      packageName === "@huggingface/transformers" &&
      [
        "dist/transformers.node.cjs",
        "dist/transformers.node.min.cjs",
        "dist/transformers.node.mjs"
      ].includes(file) &&
      edge.loader === "import" &&
      /^[A-Za-z_$][\w$]*$/.test(edge.argumentText ?? ""),
    policy: policies["optional-worker-module-import"]
  },
  {
    match: (packageName, file) =>
      packageName === "hono" && /utils\/color\.js$/.test(file),
    policy: policies["optional-platform-module"]
  },
  {
    match: (packageName, file) =>
      packageName === "@koed/privacy-service" && file === "dist/runtime.js",
    policy: policies["declared-provider-dependency"]
  },
  {
    match: (packageName, file) =>
      packageName === "@koed/mcp-server" &&
      file === "integrations/pi/managed-rpc-host.mjs",
    policy: policies["external-ai-client-sdk-path"]
  },
  {
    match: (packageName, file) =>
      packageName === "@koed-labs/server" &&
      ["dist/local-api-token.js", "dist/privacy-service-bootstrap.js"].includes(
        file
      ),
    policy: policies["selected-runtime-component-path"]
  },
  {
    match: (packageName, file) =>
      packageName === "fast-json-stringify" && file === "lib/standalone.js",
    policy: policies["runtime-generated-standalone-requires"]
  }
];
const unresolvedRules = [
  {
    match: (packageName, file, edge) => {
      const edgeSpecifier = edge.specifier;
      return (
        edge.kind === "asset" &&
        packageName === "@koed/embedding-service" &&
        file === "dist/env-config.js" &&
        edgeSpecifier === "../.env"
      );
    },
    policy: policies["optional-env-file-guarded-by-existsSync"]
  },
  {
    match: (packageName, file, edge) => {
      const edgeSpecifier = edge.specifier;
      return (
        edge.kind === "asset" &&
        packageName === "@huggingface/transformers" &&
        edgeSpecifier.endsWith(".wasm")
      );
    },
    policy: policies["onnxruntime-web-optional-wasm-asset"]
  },
  {
    match: (packageName, file, edge) => {
      return (
        edge.kind === "asset" &&
        packageName === "@koed/privacy-service" &&
        file === "dist/validation-cache.js"
      );
    },
    policy: policies["maintained-local-source-file-set"]
  },
  {
    match: (packageName, file, edge) => {
      const edgeSpecifier = edge.specifier;
      return (
        packageName === "drizzle-orm" &&
        file.startsWith("bun-") &&
        edgeSpecifier.startsWith("bun:")
      );
    },
    policy: policies["non-node-runtime-import"]
  },
  {
    match: (packageName, file, edge) => {
      const edgeSpecifier = edge.specifier;
      return (
        packageName === "pg-cloudflare" &&
        file === "dist/index.js" &&
        edgeSpecifier === "cloudflare:sockets"
      );
    },
    policy: policies["cloudflare-runtime-import"]
  },
  {
    match: (packageName, file, edge) => {
      const edgeSpecifier = edge.specifier;
      return (
        packageName === "ajv" &&
        file === "dist/runtime/re2.js" &&
        edgeSpecifier === "re2"
      );
    },
    policy: policies["optional-native-plugin-import"]
  },
  {
    match: (packageName, file, edge) => {
      const edgeSpecifier = edge.specifier;
      return (
        packageName === "@huggingface/transformers" &&
        edgeSpecifier === "onnxruntime-web/webgpu"
      );
    },
    policy: policies["non-node-webgpu-provider-import"]
  },
  {
    match: (packageName, file, edge) => {
      const edgeSpecifier = edge.specifier;
      return (
        packageName === "sharp" &&
        file === "lib/libvips.js" &&
        edgeSpecifier.startsWith("@img/sharp-libvips-dev/")
      );
    },
    policy: policies["optional-build-only-libvips-package"]
  }
];
export function classifyRuntimeException(packageName, file, edge, closure) {
  const rule = (!edge.specifier ? dynamicRules : unresolvedRules).find((rule) =>
    rule.match(packageName, file, edge)
  );
  if (!rule) return null;
  const { requiresClosure, missingClosure, ...metadata } = rule.policy;
  if (requiresClosure && !requiresClosure(closure))
    return { error: missingClosure };
  if (!edge.specifier && !["dynamic", "asset"].includes(edge.kind)) return null;
  return metadata;
}

import { build } from "esbuild";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { validateReleaseManifestCatalog } from "./embed-component-manifest-catalog.mjs";
import { verifyPackagedControlPlaneCatalog } from "./verify-packaged-control-plane-catalog.mjs";

export const readControlPlaneCatalog = ({ version }) => {
  const path = process.env.KOED_COMPONENT_MANIFEST_CATALOG;
  if (!path)
    throw new Error(
      "Control-plane packaging requires KOED_COMPONENT_MANIFEST_CATALOG build input."
    );
  return validateReleaseManifestCatalog(
    JSON.parse(readFileSync(path, "utf8")),
    version
  );
};

// Both entrypoints share one module instance: inspection reads runtime authority.
// Explicit build input replaces stale dist data without modifying frozen sources.
const createCatalogPlugin = ({
  repoRoot,
  catalog,
  version,
  cataloglessDevelopment
}) => ({
  name: "koed-release-catalog",
  setup(builder) {
    builder.onResolve({ filter: /^koed-control-plane$/ }, () => ({
      path: "koed-control-plane",
      namespace: "koed-control-plane"
    }));
    builder.onLoad({ filter: /.*/, namespace: "koed-control-plane" }, () => ({
      contents: `export * from ${JSON.stringify(resolve(repoRoot, "packages/koed-server/dist/cli.js"))}; export { productionComponentManifestCatalog } from ${JSON.stringify(resolve(repoRoot, "packages/koed-server/dist/component-manifest-catalog-data.js"))};`,
      resolveDir: repoRoot,
      loader: "js"
    }));
    builder.onLoad(
      { filter: /[/\\]component-manifest-catalog-data\.js$/ },
      () => ({
        contents: cataloglessDevelopment
          ? "export const productionComponentManifestCatalog = null;\n"
          : `import { validateManifestCatalog } from "./component-manifest-catalog.js";\nexport const productionComponentManifestCatalog = validateManifestCatalog(${JSON.stringify(validateReleaseManifestCatalog(catalog, version))});`,
        loader: "js"
      })
    );
  }
});

const bundleOptions = (options) => ({
  absWorkingDir: options.repoRoot,
  entryPoints: {
    "control-plane": "koed-control-plane",
    "component-manifest-catalog":
      "packages/koed-server/dist/component-manifest-catalog-data.js"
  },
  outdir: options.vendorRoot,
  chunkNames: "chunk-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node24",
  packages: "bundle",
  banner: {
    js: 'import { createRequire as createKoedRequire } from "node:module"; const require = createKoedRequire(import.meta.url);'
  },
  metafile: true,
  sourcemap: false,
  legalComments: "none",
  plugins: [createCatalogPlugin(options)]
});

const assertSelfContained = (built) => {
  const external = Object.values(built.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter(
      (item) =>
        item.external &&
        !item.path.startsWith("node:") &&
        !builtinModules.includes(item.path)
    );
  if (external.length)
    throw new Error(
      `Control-plane bundle has unresolved external imports: ${external.map((item) => item.path).join(", ")}`
    );
};

const assertRuntimeUsesCatalog = (built, repoRoot) => {
  const storePath = resolve(
    repoRoot,
    "packages/koed-server/dist/component-store.js"
  );
  const catalogPath = resolve(
    repoRoot,
    "packages/koed-server/dist/component-manifest-catalog-data.js"
  );
  const store = Object.entries(built.metafile.inputs).find(
    ([name]) => resolve(repoRoot, name) === storePath
  )?.[1];
  if (
    !store?.imports.some((item) => resolve(repoRoot, item.path) === catalogPath)
  )
    throw new Error(
      "Packaged runtime does not consume component catalog authority; rebuild Server before packaging."
    );
};

export const bundleControlPlane = async ({
  repoRoot,
  vendorRoot,
  version,
  catalog,
  cataloglessDevelopment = false
}) => {
  if (cataloglessDevelopment && catalog !== null)
    throw new Error(
      "Catalog-less development packaging must not carry catalog authority."
    );
  if (!cataloglessDevelopment) validateReleaseManifestCatalog(catalog, version);
  mkdirSync(vendorRoot, { recursive: true });
  writeFileSync(resolve(vendorRoot, "package.json"), '{"type":"module"}\n');
  const built = await build(
    bundleOptions({
      repoRoot,
      vendorRoot,
      version,
      catalog,
      cataloglessDevelopment
    })
  );
  assertSelfContained(built);
  assertRuntimeUsesCatalog(built, repoRoot);
  if (!cataloglessDevelopment)
    verifyPackagedControlPlaneCatalog({
      modulePath: resolve(vendorRoot, "control-plane.js"),
      catalog,
      version
    });
  writeControlPlaneLauncher(
    resolve(vendorRoot, "cli.js"),
    "./control-plane.js"
  );
  copyFileSync(
    resolve(repoRoot, "packages/koed-server/dist/privacy-service-bootstrap.js"),
    resolve(vendorRoot, "privacy-service-bootstrap.js")
  );
  return built;
};

export const writeControlPlaneLauncher = (launcher, modulePath) => {
  writeFileSync(
    launcher,
    [
      "#!/usr/bin/env node",
      'if (Number(process.versions.node.split(".")[0]) !== 24) { console.error(`@koed-labs/server requires Node.js >=24 <25; found ${process.versions.node}.`); process.exit(1); }',
      `const { runKoedServerCli, shouldExitPackagedSupervisor } = await import(${JSON.stringify(modulePath)});`,
      "const args = process.argv.slice(2);",
      "const exitCode = await runKoedServerCli(args);",
      "if (shouldExitPackagedSupervisor(args)) process.exit(exitCode);",
      "process.exitCode = exitCode;",
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
  chmodSync(launcher, 0o755);
};

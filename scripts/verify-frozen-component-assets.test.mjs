import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { buildComponentReleaseSet } from "./component-release-lib.mjs";
import {
  requiredComponentIdentities,
  writeComponentManifestCatalog
} from "./component-manifest-catalog.mjs";
import { verifyFrozenComponentAssets } from "./verify-frozen-component-assets.mjs";
import {
  candidateFixture,
  runtimeIdentities
} from "./test-utils/release-candidate-fixture.mjs";

test("frozen assets match complete catalog; manifest/archive mutation and missing tuples reject", async () => {
  mkdirSync(resolve("scratch"), { recursive: true });
  const root = mkdtempSync(resolve("scratch/frozen-assets-test-"));
  try {
    const componentsRoot = resolve(root, "components");
    const assetsDir = resolve(root, "assets");
    for (const component of ["base", "privacy", "privacy-cpu"]) {
      mkdirSync(resolve(componentsRoot, component), { recursive: true });
      writeFileSync(
        resolve(componentsRoot, component, "main.js"),
        "export {};\n"
      );
    }
    for (const target of [
      requiredComponentIdentities[0].target,
      requiredComponentIdentities.find(
        (entry) => entry.target.platform === "macos"
      ).target
    ])
      buildComponentReleaseSet({
        componentsRoot,
        outDir: assetsDir,
        version: "1.2.3",
        target,
        runtimes: [
          {
            kind: "node",
            runtimeRange: ">=24 <25",
            nodeRange: ">=24 <25",
            modulesAbi: "137"
          },
          ...(target.platform === "macos"
            ? [
                {
                  kind: "electron",
                  runtimeRange: "=39.8.10",
                  nodeRange: "=22.22.1",
                  modulesAbi: "140",
                  minimumNapi: 10
                }
              ]
            : [])
        ],
        requiredFiles: { base: ["main.js"], privacy: ["main.js"] }
      });
    const catalogPath = resolve(assetsDir, "component-manifest-hashes.json");
    writeComponentManifestCatalog({
      manifestsDir: assetsDir,
      outputPath: catalogPath,
      version: "1.2.3"
    });
    await verifyFrozenComponentAssets({
      assetsDir,
      catalogPath,
      version: "1.2.3"
    });
    const archive = resolve(assetsDir, "koed-base-1.2.3-linux-x64.tar.gz");
    const original = readFileSync(archive);
    writeFileSync(archive, Buffer.alloc(original.length));
    await assert.rejects(
      verifyFrozenComponentAssets({ assetsDir, catalogPath, version: "1.2.3" }),
      /archive.*mismatch/i
    );
    writeFileSync(archive, original);
    rmSync(
      resolve(assetsDir, "koed-privacy-1.2.3-macos-arm64.tar.gz.manifest.json")
    );
    await assert.rejects(
      verifyFrozenComponentAssets({ assetsDir, catalogPath, version: "1.2.3" }),
      /missing|complete/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [label, runtimes, rejects] of [
  [
    "self-authorized ABI",
    [
      {
        kind: "node",
        runtimeRange: ">=24 <25",
        nodeRange: ">=24 <25",
        modulesAbi: "999"
      }
    ],
    true
  ],
  [
    "missing Electron",
    [
      {
        kind: "node",
        runtimeRange: ">=24 <25",
        nodeRange: ">=24 <25",
        modulesAbi: "137"
      }
    ],
    true
  ],
  [
    "NAPI-only",
    [
      {
        kind: "node",
        runtimeRange: ">=24 <25",
        nodeRange: ">=24 <25",
        minimumNapi: 10
      },
      {
        kind: "electron",
        runtimeRange: "=39.8.10",
        nodeRange: "=22.22.1",
        minimumNapi: 10
      }
    ],
    false
  ],
  [
    "Electron ABI",
    [
      {
        kind: "node",
        runtimeRange: ">=24 <25",
        nodeRange: ">=24 <25",
        modulesAbi: "137"
      },
      {
        kind: "electron",
        runtimeRange: "=39.8.10",
        nodeRange: "=22.22.1",
        modulesAbi: "999"
      }
    ],
    true
  ]
])
  test(`independent runtime matrix checks ${label}`, async () => {
    const f = candidateFixture({ runtimes });
    try {
      const result = verifyFrozenComponentAssets({
        assetsDir: f.assetsDir,
        catalogPath: resolve(f.assetsDir, "component-manifest-hashes.json"),
        version: "1.2.3",
        runtimeIdentities
      });
      if (rejects) await assert.rejects(result, /runtime|compatible|ABI/i);
      else await result;
    } finally {
      f.cleanup();
    }
  });

for (const damage of ["missing", "duplicate", "ABI", "Electron", "libc"])
  test(`protected runtime matrix rejects ${damage}`, async () => {
    const f = candidateFixture();
    const identities = structuredClone(runtimeIdentities);
    if (damage === "missing") identities.pop();
    if (damage === "duplicate") identities.push(identities[0]);
    if (damage === "ABI") identities[0].modulesAbi = "999";
    if (damage === "Electron") identities[2].version = "40.0.0";
    if (damage === "libc") identities[0].libcVersion = "999.0";
    try {
      await assert.rejects(
        verifyFrozenComponentAssets({
          assetsDir: f.assetsDir,
          catalogPath: resolve(f.assetsDir, "component-manifest-hashes.json"),
          version: "1.2.3",
          runtimeIdentities: identities
        }),
        /runtime|matrix|identity/i
      );
    } finally {
      f.cleanup();
    }
  });

for (const [field, value] of [
  ["runtimeRange", "=40.0.0"],
  ["nodeRange", "=24.13.1"],
  ["minimumNapi", 11]
])
  test(`independent Electron consumer rejects incompatible ${field}`, async () => {
    const runtimes = [
      {
        kind: "node",
        runtimeRange: ">=24 <25",
        nodeRange: ">=24 <25",
        modulesAbi: "137"
      },
      {
        kind: "electron",
        runtimeRange: "=39.8.10",
        nodeRange: "=22.22.1",
        modulesAbi: "140",
        minimumNapi: 10,
        [field]: value
      }
    ];
    const f = candidateFixture({ runtimes });
    try {
      await assert.rejects(
        verifyFrozenComponentAssets({
          assetsDir: f.assetsDir,
          catalogPath: resolve(f.assetsDir, "component-manifest-hashes.json"),
          version: "1.2.3"
        }),
        /runtime|compatible/i
      );
    } finally {
      f.cleanup();
    }
  });

test("runtime compatibility cannot combine ABI and NAPI across alternative records", async () => {
  const f = candidateFixture({
    runtimes: [
      {
        kind: "node",
        runtimeRange: ">=24 <25",
        nodeRange: ">=24 <25",
        modulesAbi: "137",
        minimumNapi: 11
      },
      {
        kind: "node",
        runtimeRange: ">=24 <25",
        nodeRange: ">=24 <25",
        modulesAbi: "999",
        minimumNapi: 10
      }
    ]
  });
  try {
    await assert.rejects(
      verifyFrozenComponentAssets({
        assetsDir: f.assetsDir,
        catalogPath: resolve(f.assetsDir, "component-manifest-hashes.json"),
        version: "1.2.3"
      }),
      /runtime|compatible/i
    );
  } finally {
    f.cleanup();
  }
});

import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const studioRoot = fileURLToPath(new URL("../", import.meta.url));
await mkdir(new URL("../.desktop-ui/", import.meta.url), { recursive: true });
await build({
  absWorkingDir: studioRoot,
  entryPoints: ["../desktop/src/renderer/studio-shared.ts"],
  outfile: ".desktop-ui/index.js",
  bundle: true,
  plugins: [
    {
      name: "shared-react-esm",
      setup(builder) {
        builder.onResolve({ filter: /^react$/ }, (args) =>
          args.kind === "require-call"
            ? { path: "react", namespace: "shared-react-esm" }
            : undefined
        );
        builder.onLoad(
          { filter: /^react$/, namespace: "shared-react-esm" },
          () => ({ contents: 'export * from "react";', loader: "js" })
        );
      }
    }
  ],
  platform: "browser",
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  external: [
    "react",
    "react/*",
    "react-dom",
    "react-dom/*",
    "@koed/shared/*",
    "lucide-react"
  ]
});
await writeFile(
  new URL("../.desktop-ui/index.d.ts", import.meta.url),
  'export * from "../../desktop/src/renderer/studio-shared.js";\n'
);

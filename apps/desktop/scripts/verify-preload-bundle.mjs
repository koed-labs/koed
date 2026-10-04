import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { argv, stdout } from "node:process";
import { fileURLToPath } from "node:url";

export const verifyPreloadBundles = async (directory) => {
  for (const name of ["preload.cjs", "studio-preload.cjs"]) {
    const source = await readFile(resolve(directory, name), "utf8");
    const externalRequires = [
      ...source.matchAll(/require\(["']([^"']+)["']\)/g)
    ].map((match) => match[1]);
    const unexpectedRequires = [
      ...new Set(
        externalRequires.filter((specifier) => specifier !== "electron")
      )
    ];

    if (unexpectedRequires.length > 0 || source.includes("@koed/")) {
      throw new Error(
        `${name} contains unresolved runtime imports: ${[
          ...unexpectedRequires,
          ...(source.includes("@koed/") ? ["@koed/*"] : [])
        ].join(", ")}`
      );
    }

    if (!source.includes('require("electron")')) {
      throw new Error(`${name} does not retain the Electron bridge import.`);
    }

    const forbiddenRendererAuthority = [
      "Koed-Desktop ",
      "Bearer ",
      "document.cookie",
      ".localStorage",
      ".sessionStorage",
      "indexedDB",
      "new WebSocket(",
      "new EventSource(",
      "fetch("
    ].filter((marker) => source.includes(marker));

    if (forbiddenRendererAuthority.length > 0) {
      throw new Error(
        `${name} contains forbidden credential, storage, or direct-network authority: ${forbiddenRendererAuthority.join(", ")}`
      );
    }
  }
};

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyPreloadBundles(resolve("dist-electron"));
  stdout.write("Verified sandboxed preload bundle imports.\n");
}

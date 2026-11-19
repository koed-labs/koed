import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdout } from "node:process";

for (const bundle of ["preload.cjs", "floating-kin-preload.cjs"]) {
  const source = await readFile(resolve("dist-electron", bundle), "utf8");
  const externalRequires = [
    ...source.matchAll(/require\(["']([^"']+)["']\)/g)
  ].map((match) => match[1]);
  const unexpectedRequires = [
    ...new Set(externalRequires.filter((specifier) => specifier !== "electron"))
  ];

  if (unexpectedRequires.length > 0 || source.includes("@koed-labs/")) {
    throw new Error(
      `${bundle} contains unresolved runtime imports: ${[
        ...unexpectedRequires,
        ...(source.includes("@koed-labs/") ? ["@koed-labs/*"] : [])
      ].join(", ")}`
    );
  }

  if (!externalRequires.includes("electron")) {
    throw new Error(`${bundle} does not retain the Electron bridge import.`);
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
      `${bundle} contains forbidden credential, storage, or direct-network authority: ${forbiddenRendererAuthority.join(", ")}`
    );
  }
}

stdout.write("Verified sandboxed preload bundle imports.\n");

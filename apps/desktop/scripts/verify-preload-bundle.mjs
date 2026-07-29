import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdout } from "node:process";

const preloadPath = resolve("dist-electron/preload.cjs");
const source = await readFile(preloadPath, "utf8");
const externalRequires = [
  ...source.matchAll(/require\(["']([^"']+)["']\)/g)
].map((match) => match[1]);
const unexpectedRequires = [
  ...new Set(externalRequires.filter((specifier) => specifier !== "electron"))
];

if (unexpectedRequires.length > 0 || source.includes("@koed/")) {
  throw new Error(
    `Sandboxed preload contains unresolved runtime imports: ${[
      ...unexpectedRequires,
      ...(source.includes("@koed/") ? ["@koed/*"] : [])
    ].join(", ")}`
  );
}

if (!source.includes('require("electron")')) {
  throw new Error(
    "Sandboxed preload does not retain the Electron bridge import."
  );
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
    `Sandboxed preload contains forbidden credential, storage, or direct-network authority: ${forbiddenRendererAuthority.join(", ")}`
  );
}

stdout.write("Verified sandboxed preload bundle imports.\n");

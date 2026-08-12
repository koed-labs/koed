import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const outputRoot = resolve(import.meta.dirname, "../dist/browser-approval");
const indexPath = resolve(outputRoot, "index.html");
if (!existsSync(indexPath)) {
  throw new Error("Browser approval build did not produce index.html");
}

const html = readFileSync(indexPath, "utf8");
const assetReferences = [
  ...html.matchAll(/(?:src|href)="(\/browser-approval\/assets\/[^"]+)"/g)
].map((match) => match[1]);
if (assetReferences.length === 0) {
  throw new Error(
    "Browser approval build did not reference fingerprinted assets"
  );
}

const assetNames = new Set(readdirSync(resolve(outputRoot, "assets")));
for (const reference of assetReferences) {
  const name = reference.split("/").at(-1);
  if (!name || !/-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/.test(name)) {
    throw new Error(
      `Browser approval asset is not fingerprinted: ${reference}`
    );
  }
  if (!assetNames.has(name)) {
    throw new Error(`Browser approval asset is missing: ${reference}`);
  }
}

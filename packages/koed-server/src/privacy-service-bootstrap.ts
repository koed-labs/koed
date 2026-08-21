import { pathToFileURL } from "node:url";

const [entry, cacheDir] = process.argv.slice(2);
if (!entry || !cacheDir)
  throw new Error(
    "Privacy Service bootstrap requires entry and cache directory"
  );

process.env.KOED_PRIVACY_TRANSFORMERS_CACHE = cacheDir;
await import(pathToFileURL(entry).href);

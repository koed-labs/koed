#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MODEL_ID = "openai/privacy-filter";
const MODEL_REVISION = "7ffa9a043d54d1be65afb281eddf0ffbe629385b";

// Keep this standalone manifest aligned with
// packages/shared/src/privacy-classifier-generation.ts.
const FILES = [
  {
    path: "onnx/model_q4.onnx",
    sha256: "8f7dee8b46d096f052b359375dfba5d983cc4d18c44a783bf548615c472f8dea",
    size: 160_219
  },
  {
    path: "onnx/model_q4.onnx_data",
    sha256: "f30998e28c71c5374cc7e8b7de8f0f83e981592c0c2d652d2ad4928454dbb496",
    size: 917_120_144
  },
  {
    path: "tokenizer.json",
    sha256: "0614fe83cadab421296e664e1f48f4261fa8fef6e03e63bb75c20f38e37d07d3"
  },
  {
    path: "viterbi_calibration.json",
    sha256: "bbc8611ef08a55ed72d64856cbbbb9a91db8dfa881f0a92e2afbad6e4bbc775a"
  },
  {
    path: "config.json",
    sha256: "b2b26a4a4a000639ad30b0c264adbefe365bdb567fbd7bb27303b8c438375bd1"
  },
  {
    path: "tokenizer_config.json",
    sha256: "6c14af9ce1a284d3c3c5146b26efe4cd589c68e1dd4e9d94455606ec911ba774"
  }
];

const usage = `Usage: node scripts/download-privacy-model.mjs

Downloads and verifies Koed's pinned Privacy Filter model. By default, files
are installed below ~/.koed/models/privacy. KOED_HOME and KOED_MODELS_DIR are
honoured when set.`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(usage);
  process.exit(0);
}

if (process.argv.length > 2) {
  console.error(usage);
  process.exit(1);
}

const koedHome = process.env.KOED_HOME?.trim()
  ? resolve(process.env.KOED_HOME)
  : resolve(homedir(), ".koed");
const modelsDir = process.env.KOED_MODELS_DIR?.trim()
  ? resolve(process.env.KOED_MODELS_DIR)
  : resolve(koedHome, "models");
const blobsDir = resolve(modelsDir, "privacy", "blobs", "sha256");
const cacheRoot = resolve(modelsDir, "privacy", "transformers-cache");
const modelCacheDir = resolve(cacheRoot, MODEL_ID, MODEL_REVISION);

const sha256File = async (path) => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
};

const isValidFile = async (path, file) => {
  if (!existsSync(path)) return false;
  if (file.size !== undefined && statSync(path).size !== file.size)
    return false;
  return (await sha256File(path)) === file.sha256;
};

const downloadFile = async (file, destination) => {
  const url =
    `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/` + file.path;
  const temporary = `${destination}.${process.pid}.download`;
  rmSync(temporary, { force: true });

  console.log(`Downloading ${file.path} ...`);
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary, { mode: 0o600 })
    );

    if (!(await isValidFile(temporary, file))) {
      const actualHash = await sha256File(temporary);
      const actualSize = statSync(temporary).size;
      throw new Error(
        `${file.path} failed verification (size ${actualSize}, SHA-256 ${actualHash})`
      );
    }

    rmSync(destination, { force: true });
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};

const materializeCacheEntry = (file, blob) => {
  const target = resolve(modelCacheDir, file.path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  rmSync(target, { force: true });
  linkSync(blob, target);
};

try {
  mkdirSync(blobsDir, { recursive: true, mode: 0o700 });

  for (const file of FILES) {
    const blob = resolve(blobsDir, file.sha256);
    if (await isValidFile(blob, file)) {
      console.log(`Using verified ${file.path}`);
    } else {
      await downloadFile(file, blob);
    }
    materializeCacheEntry(file, blob);
  }

  console.log(
    `Privacy Filter model installed and verified at ${modelCacheDir}`
  );
} catch (error) {
  console.error(
    `Privacy Filter model installation failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exit(1);
}

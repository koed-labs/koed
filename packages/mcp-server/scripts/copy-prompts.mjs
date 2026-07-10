#!/usr/bin/env node
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageRoot, "..", "..");
const sourceDirectory = resolve(repoRoot, "prompts");
const targetDirectory = resolve(packageRoot, "dist", "prompts");

if (!existsSync(sourceDirectory)) {
  throw new Error(`Koed prompt source directory not found: ${sourceDirectory}`);
}

rmSync(targetDirectory, { recursive: true, force: true });
cpSync(sourceDirectory, targetDirectory, { recursive: true });

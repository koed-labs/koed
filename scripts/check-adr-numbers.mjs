#!/usr/bin/env node
import { resolve } from "node:path";
import {
  checkAdrDirectory,
  formatAdrNumberProblems
} from "./adr-numbers-lib.mjs";

const adrDirectory = resolve(import.meta.dirname, "..", "docs", "adr");
const problems = checkAdrDirectory(adrDirectory);

if (problems.duplicates.length > 0 || problems.invalidNames.length > 0) {
  console.error(formatAdrNumberProblems(problems));
  console.error("Give each ADR the next unused number in docs/adr.");
  process.exit(1);
}

console.log("ADR numbers are unique.");

#!/usr/bin/env node
import { resolve } from "node:path";
import {
  assertChangesetReleasePolicy,
  assertProductPackageVersions,
  assertReleaseWorkflowVersionPropagation
} from "./product-release-version-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const version = assertProductPackageVersions(root);
assertChangesetReleasePolicy(root);
assertReleaseWorkflowVersionPropagation(root);
console.log(`Koed product release version ${version} is synchronized.`);

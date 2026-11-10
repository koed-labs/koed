import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createOperationReceipt } from "./operation-receipt.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it("retains only an operation receipt across process recreation and rejects corrupt input", () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch", "operation-receipt-"));
  roots.push(root);
  const path = resolve(root, "operation.json");
  expect(createOperationReceipt(path).previous).toBeNull();
  const receipt = {
    id: "d6abf730-0f02-4adc-a7e6-4ddf98f30905",
    sequence: 2,
    state: "running" as const
  };
  createOperationReceipt(path).save(receipt);
  expect(createOperationReceipt(path).previous).toEqual(receipt);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(receipt);
  writeFileSync(path, JSON.stringify({ ...receipt, installCuda: true }));
  expect(createOperationReceipt(path).previous).toBeNull();
});

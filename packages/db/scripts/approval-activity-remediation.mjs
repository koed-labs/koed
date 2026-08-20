#!/usr/bin/env node

import pg from "pg";
import {
  correctApprovalActivity,
  inventoryApprovalActivity
} from "../dist/index.js";

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const operation = process.argv[2] ?? "inventory";
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
if (!new Set(["inventory", "correct"]).has(operation)) {
  throw new Error(
    "Usage: approval-activity-remediation.mjs inventory|correct [--owner-user-id UUID] [--session-id UUID] [--apply]"
  );
}
if (operation === "correct" && !process.argv.includes("--apply")) {
  throw new Error("Correction is mutating and requires --apply");
}

const pool = new pg.Pool({ connectionString });
try {
  const scope = {
    ...(argument("--owner-user-id")
      ? { ownerUserId: argument("--owner-user-id") }
      : {}),
    ...(argument("--session-id") ? { sessionId: argument("--session-id") } : {})
  };
  const result =
    operation === "inventory"
      ? await inventoryApprovalActivity(pool, scope)
      : await correctApprovalActivity(pool, scope);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await pool.end();
}

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const receiptSchema = z
  .object({
    id: z.string().uuid(),
    sequence: z.number().int().positive(),
    state: z.enum([
      "running",
      "complete",
      "failed",
      "cancelled",
      "interrupted"
    ]),
    // The run included explicit consent (such as CUDA) that lives only in
    // memory. If it was interrupted, the User must choose again; this never
    // authorizes resuming that work.
    reviewProcessing: z.literal(true).optional()
  })
  .strict();
export type OperationReceipt = z.infer<typeof receiptSchema>;

// This is an observation receipt, never permission to resume work. It contains
// no configuration, credentials, progress estimates, or installer input.
export function createOperationReceipt(path: string) {
  let previous: OperationReceipt | null = null;
  try {
    previous = receiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    /* Missing/corrupt history cannot authorize work. */
  }
  return {
    previous,
    save(receipt: OperationReceipt) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(receiptSchema.parse(receipt)), {
          flag: "wx",
          mode: 0o600
        });
        renameSync(temporary, path);
      } finally {
        try {
          unlinkSync(temporary);
        } catch {
          /* Rename already consumed it. */
        }
      }
    }
  };
}

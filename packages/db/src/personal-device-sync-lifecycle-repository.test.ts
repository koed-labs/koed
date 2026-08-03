import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createPersonalDeviceSyncLifecycleRepository } from "./personal-device-sync-lifecycle-repository.js";

describe("Personal Device Sync lifecycle repository", () => {
  it("orders unioned lifecycle controls numerically through a derived table", async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("from personal_device_groups g")) {
          return {
            rowCount: 1,
            rows: [
              {
                head_sequence: "1",
                head_hash: "head",
                canonical_statement: "{}"
              }
            ]
          };
        }
        return { rowCount: 0, rows: [] };
      })
    } as unknown as pg.Pool;

    const result = await createPersonalDeviceSyncLifecycleRepository(
      pool
    ).getPdsLifecycleControl({
      groupDbId: "group-db",
      groupId: "group",
      cursor: "0",
      limit: 10
    });

    expect(result.controls).toEqual([]);
    expect(
      queries.find((query) => query.includes("pds_conflict_resolution_records"))
    ).toMatch(
      /from \(\s*select[\s\S]*union all[\s\S]*\) lifecycle\s*order by lifecycle\.sequence::numeric/
    );
  });

  it("accepts an identical repeated lifecycle checkpoint", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("from pds_replica_lifecycle_state")) {
          const row: Record<string, string> = {
            authority_sequence: "4",
            lifecycle_high_water: "2",
            restore_high_water: "2"
          };
          if (sql.includes("authority_head")) row.authority_head = "head-4";
          return { rowCount: 1, rows: [row] };
        }
        if (sql.includes("select id from personal_device_groups")) {
          return { rowCount: 1, rows: [{ id: "group-db" }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn()
    };
    const pool = {
      connect: vi.fn(async () => client)
    } as unknown as pg.Pool;

    const result = await createPersonalDeviceSyncLifecycleRepository(
      pool
    ).reconcilePdsRestore({
      groupId: "group",
      deviceId: "device",
      authorityHead: "head-4",
      authoritySequence: "4",
      lifecycleHighWater: "2"
    });

    expect(result).toEqual({ accepted: true });
    expect(
      queries.some((query) => query.includes("state='equivocation_freeze'"))
    ).toBe(false);
    expect(
      queries.some((query) =>
        query.includes("insert into pds_replica_lifecycle_state")
      )
    ).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });
});

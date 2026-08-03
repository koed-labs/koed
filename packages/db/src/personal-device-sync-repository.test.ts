import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createPersonalDeviceSyncRepository } from "./personal-device-sync-repository.js";

const groupRow = (state = "active") => ({
  id: "group-db",
  group_id: "group",
  authority_key_id: "authority",
  authority_public_key: "authority-public",
  recovery_signing_key_id: "recovery-signing",
  recovery_signing_public_key: "recovery-signing-public",
  recovery_kem_key_id: "recovery-kem",
  recovery_kem_public_key: "recovery-kem-public",
  recovery_kit_hash: "recovery-kit",
  current_epoch: "1",
  pending_epoch: null,
  pending_statement_sequence: null,
  pending_statement_hash: null,
  pending_bundle_hash: null,
  head_sequence: "1",
  head_hash: "head",
  state,
  state_reason: null,
  enabled: false,
  future_closed_sessions_only: true,
  historical_backfill_enabled: false
});

describe("Personal Device Sync repository authority reads", () => {
  it("orders group statements by numeric sequence", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("from personal_device_groups"))
        return { rowCount: 1, rows: [groupRow()] };
      if (text.includes("from personal_device_group_members"))
        return { rowCount: 0, rows: [] };
      return {
        rowCount: 3,
        rows: [
          { sequence: "1", statement_hash: "one", canonical_statement: "{}" },
          { sequence: "2", statement_hash: "two", canonical_statement: "{}" },
          { sequence: "10", statement_hash: "ten", canonical_statement: "{}" }
        ]
      };
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() }))
    } as unknown as pg.Pool;

    const statements = await createPersonalDeviceSyncRepository(
      pool
    ).listPersonalDeviceGroupStatements("user", "group");

    expect(statements.map((statement) => statement.sequence)).toEqual([
      "1",
      "2",
      "10"
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("order by sequence::numeric"),
      ["group-db"]
    );
  });

  it("derives membership epoch from signed statement bytes", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("from personal_device_groups"))
        return { rowCount: 1, rows: [groupRow()] };
      if (text.includes("from personal_device_group_members"))
        return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() }))
    } as unknown as pg.Pool;

    await expect(
      createPersonalDeviceSyncRepository(pool).commitPersonalDeviceTransition({
        userId: "user",
        groupId: "group",
        expectedHeadHash: "head",
        sequence: "2",
        nextEpoch: "3",
        kind: "add-device",
        statementHash: "statement-hash",
        statement: '{"draft":{"body":{"nextEpoch":"2","previousEpoch":"1"}}}',
        authorizationKeyId: "device-key",
        browserSubjectId: "user",
        browserDeploymentId: "deployment"
      })
    ).rejects.toMatchObject({
      message: "PDS membership epoch is stale",
      statusCode: 409
    });
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining("update personal_device_groups set"),
      expect.anything()
    );
  });

  it("refuses same-epoch certificates from a stale authority head", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("from personal_device_groups"))
        return { rowCount: 1, rows: [groupRow()] };
      if (text.includes("from personal_device_group_members"))
        return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() }))
    } as unknown as pg.Pool;

    await expect(
      createPersonalDeviceSyncRepository(
        pool
      ).getPersonalDeviceMembershipCertificate({
        userId: "user",
        groupId: "group",
        deviceId: "device"
      })
    ).resolves.toBeNull();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("c.statement_sequence=$3"),
      ["group-db", "1", "1", "head", "authority", "device"]
    );
  });

  it("serves recovery bundle without active device but blocks frozen governance", async () => {
    const activeQuery = vi.fn(async (text: string) => {
      if (text.includes("from personal_device_groups"))
        return { rowCount: 1, rows: [groupRow()] };
      if (text.includes("from personal_device_group_members"))
        return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ canonical_bundle: "{}" }] };
    });
    const frozenQuery = vi.fn(async (text: string) => {
      if (text.includes("from personal_device_groups"))
        return { rowCount: 1, rows: [groupRow("equivocation_freeze")] };
      return { rowCount: 0, rows: [] };
    });
    const activePool = {
      connect: vi.fn(async () => ({ query: activeQuery, release: vi.fn() }))
    } as unknown as pg.Pool;
    const frozenPool = {
      connect: vi.fn(async () => ({ query: frozenQuery, release: vi.fn() }))
    } as unknown as pg.Pool;

    await expect(
      createPersonalDeviceSyncRepository(activePool).getPersonalDeviceKeyBundle(
        { userId: "user", groupId: "group", epoch: "1" }
      )
    ).resolves.toBe("{}");
    await expect(
      createPersonalDeviceSyncRepository(frozenPool).getPersonalDeviceKeyBundle(
        { userId: "user", groupId: "group", epoch: "1" }
      )
    ).resolves.toBeNull();
  });
});

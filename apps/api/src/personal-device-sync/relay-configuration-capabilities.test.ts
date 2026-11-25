import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  PdsRelayClient,
  requirePdsConfigurationCapability,
  type PdsConfigurationCapabilityRecord,
  type PersonalConfigurationFeature
} from "@koed-labs/shared";
import {
  createDbPool,
  createPersonalDeviceSyncRelayRepository,
  runDbMigrations
} from "@koed-labs/db";
import { personalSourceDeviceFixture } from "../../../../packages/db/tests/fixtures/personal-source-device.js";
import type { ApiRouteContext } from "../server/context.js";
import { registerPersonalDeviceSyncRelayRoutes } from "./relay-routes.js";

const base = [
  "source_context_v1",
  "project_membership_v1",
  "project_defaults_v1"
] as const;
// Freeze the wire shape used by the previous release, including its rejection
// of extra top-level keys. Verify the signatures with the protocol verifier.
const legacyAdvertisement = z.strictObject({
  protocol: z.literal("koed/personal-configuration/v1"),
  features: z.array(z.enum(base)).min(1).max(3),
  advertisedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true })
});
const kinFeatures = [...base, "project_kin_v1"] as const;
const kinAdvertisement = legacyAdvertisement.extend({
  features: z.array(z.enum(kinFeatures)).min(1).max(4),
  baseNonce: z.string()
});
const accessoryFeatures = [
  ...kinFeatures,
  "project_kin_accessories_v1"
] as const;

function client(
  member: ReturnType<typeof personalSourceDeviceFixture>["origin"],
  fetch: typeof globalThis.fetch
) {
  return new PdsRelayClient({
    baseUrl: "http://127.0.0.1",
    identity: {
      certificate: member.certificate,
      deviceId: member.deviceId,
      signingKeyId: member.signingKeyId,
      signingPublicKey: member.signing.publicKey,
      signingPrivateSeed: member.signing.privateSeed
    },
    fetch
  });
}

describe("signed configuration capabilities during upgrades", () => {
  it("only publishes the base view when an older relay acknowledges it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(
        legacyAdvertisement.parse(JSON.parse(String(init?.body))).features
      ).toEqual(base);
      return Response.json({ accepted: true });
    });
    await client(
      personalSourceDeviceFixture().origin,
      fetch
    ).advertiseConfigurationCapabilities([...accessoryFeatures]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("advertises the legacy Kin view to a relay without the accessory extension", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.baseNonce) {
        expect(kinAdvertisement.parse(body).features).toEqual(kinFeatures);
        return Response.json({ accepted: true });
      }
      expect(legacyAdvertisement.parse(body).features).toEqual(base);
      return Response.json({ accepted: true, extensionNonce: "a".repeat(43) });
    });
    await client(
      personalSourceDeviceFixture().origin,
      fetch
    ).advertiseConfigurationCapabilities([...accessoryFeatures]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "serves one verifiable view per peer through upgrades, downgrades and reordered refreshes",
    async () => {
      const pool = createDbPool({
        connectionString: process.env.DATABASE_URL!
      });
      const app = Fastify();
      const f = personalSourceDeviceFixture();
      const repository = createPersonalDeviceSyncRelayRepository(pool);
      registerPersonalDeviceSyncRelayRoutes(app, {
        requireRepository: () => repository,
        rateLimit: { memoryRead: async () => {}, memoryWrite: async () => {} },
        personalDeviceSync: { authoritySigner: {} }
      } as unknown as ApiRouteContext);
      const fetch: typeof globalThis.fetch = async (url, init) => {
        const u = new URL(String(url));
        const res = await app.inject({
          method: init!.method as "GET" | "POST",
          url: u.pathname + u.search,
          headers: Object.fromEntries(new Headers(init!.headers)),
          payload: init?.body ? String(init.body) : undefined
        });
        return new Response(res.body, { status: res.statusCode });
      };
      const origin = client(f.origin, fetch),
        receiver = client(f.receiver, fetch);
      const readLegacyFeatures = (
        records: PdsConfigurationCapabilityRecord[]
      ) => {
        expect(records).toHaveLength(1);
        return legacyAdvertisement.parse(
          JSON.parse(records[0]!.canonicalAdvertisement)
        ).features;
      };
      const check = (
        records: PdsConfigurationCapabilityRecord[],
        deviceId: string,
        feature: PersonalConfigurationFeature
      ) =>
        requirePdsConfigurationCapability({
          records,
          feature,
          intendedRecipientDeviceIds: [deviceId],
          groupId: f.groupId,
          authorityHead: f.authorityHead,
          currentEpoch: f.epoch,
          authorityPublicKey: f.authorityPublicKey,
          authorityKeyId: f.authorityKeyId,
          activeCertificates: f.certificates
        });
      try {
        await runDbMigrations(pool);
        await f.initialize(pool, f.origin);
        await origin.advertiseConfigurationCapabilities([...accessoryFeatures]);
        await receiver.advertiseConfigurationCapabilities([...base]);
        const legacy = await receiver.configurationCapabilities();
        expect(readLegacyFeatures(legacy)).toEqual(base);
        for (const feature of base) check(legacy, f.origin.deviceId, feature);
        const oldPeer = await origin.configurationCapabilities({
          includeExtended: true
        });
        expect(readLegacyFeatures(oldPeer)).toEqual(base);
        for (const feature of base)
          check(oldPeer, f.receiver.deviceId, feature);
        expect(() =>
          check(oldPeer, f.receiver.deviceId, "project_kin_v1")
        ).toThrow(/pending/i);
        const upgraded = await receiver.configurationCapabilities({
          includeExtended: true
        });
        expect(upgraded).toHaveLength(1);
        expect(
          kinAdvertisement.parse(
            JSON.parse(upgraded[0]!.canonicalAdvertisement)
          ).features
        ).toEqual(kinFeatures);
        check(upgraded, f.origin.deviceId, "project_kin_v1");
        expect(() =>
          check(upgraded, f.origin.deviceId, "project_kin_accessories_v1")
        ).toThrow(/pending/i);
        const accessoryAware = await receiver.configurationCapabilities({
          includeKinAccessories: true
        });
        expect(accessoryAware).toHaveLength(1);
        check(accessoryAware, f.origin.deviceId, "project_kin_accessories_v1");
        // Insert a base-only refresh before delivering the in-flight extension.
        // Equal timestamps ensure that only the base nonce distinguishes them.
        const generation = new Date();
        const downgrade = vi.fn(() =>
          origin.advertiseConfigurationCapabilities([...base], generation)
        );
        const delayed = client(f.origin, async (url, init) => {
          if (
            JSON.parse(String(init?.body)).baseNonce &&
            !downgrade.mock.calls.length
          )
            await downgrade();
          return fetch(url, init);
        });
        await delayed.advertiseConfigurationCapabilities(
          [...accessoryFeatures],
          generation
        );
        expect(downgrade).toHaveBeenCalledOnce();
        const downgraded = await receiver.configurationCapabilities({
          includeKinAccessories: true
        });
        expect(readLegacyFeatures(downgraded)).toEqual(base);
        check(downgraded, f.origin.deviceId, "project_membership_v1");
        expect(() =>
          check(downgraded, f.origin.deviceId, "project_kin_v1")
        ).toThrow(/pending/i);
        expect(() =>
          check(downgraded, f.origin.deviceId, "project_kin_accessories_v1")
        ).toThrow(/pending/i);
      } finally {
        await app.close();
        await pool.end();
      }
    },
    60_000
  );
});

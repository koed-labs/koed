import type pg from "pg";
import {
  pdsConfigurationCapabilityAdvertisementSchema,
  parseCanonicalPdsJson,
  parsePdsRelayRequestProof,
  verifyPdsRelayRequestProof,
  PDS_CONFIGURATION_CAPABILITY_PATH,
  type PdsConfigurationCapabilityRecord
} from "@koed/shared";
import type { PdsRelayAuthContext } from "./personal-device-sync-relay-repository.js";

type Authenticate = (
  client: pg.PoolClient,
  input: PdsRelayAuthContext
) => Promise<PdsRelayAuthContext>;
/** Stores signed protocol flags only. Context, names, paths, and membership stay encrypted. */
export const createPdsConfigurationCapabilityRepository = (
  pool: pg.Pool,
  authenticate: Authenticate
) => ({
  async advertisePdsConfigurationCapability(
    input: PdsRelayAuthContext & {
      canonicalAdvertisement: string;
      canonicalRequestProof: string;
    }
  ): Promise<void> {
    const advertisement = pdsConfigurationCapabilityAdvertisementSchema.parse(
      parseCanonicalPdsJson(input.canonicalAdvertisement)
    );
    const proof = parsePdsRelayRequestProof(input.canonicalRequestProof);
    if (
      Buffer.byteLength(input.canonicalAdvertisement, "utf8") > 4096 ||
      Buffer.byteLength(input.canonicalRequestProof, "utf8") > 8192
    )
      throw new TypeError("PDS configuration capability is too large");
    const client = await pool.connect();
    try {
      await client.query("begin");
      const auth = await authenticate(client, input),
        now = new Date();
      if (
        proof.deviceId !== auth.deviceId ||
        proof.deviceSigningKeyId !== auth.signingKeyId ||
        Math.abs(
          new Date(advertisement.advertisedAt).getTime() - now.getTime()
        ) > 60_000 ||
        new Date(advertisement.expiresAt) <= now
      )
        throw Object.assign(
          new Error(
            "PDS configuration capability is stale or has invalid authority"
          ),
          { statusCode: 400 }
        );
      verifyPdsRelayRequestProof({
        proof,
        method: "POST",
        target: PDS_CONFIGURATION_CAPABILITY_PATH,
        body: Buffer.from(input.canonicalAdvertisement, "utf8"),
        signingPublicKey: auth.signingPublicKey,
        now
      });
      await client.query(
        `insert into pds_configuration_capabilities(group_id,device_id,canonical_advertisement,canonical_request_proof,advertised_at,expires_at)
        values($1,$2,$3,$4,$5,$6) on conflict(group_id,device_id) do update set canonical_advertisement=excluded.canonical_advertisement,canonical_request_proof=excluded.canonical_request_proof,advertised_at=excluded.advertised_at,expires_at=excluded.expires_at,updated_at=now()
        where pds_configuration_capabilities.advertised_at<=excluded.advertised_at`,
        [
          auth.groupDbId,
          auth.deviceId,
          input.canonicalAdvertisement,
          input.canonicalRequestProof,
          new Date(advertisement.advertisedAt),
          new Date(advertisement.expiresAt)
        ]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },
  async listPdsConfigurationCapabilities(
    input: PdsRelayAuthContext
  ): Promise<PdsConfigurationCapabilityRecord[]> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const auth = await authenticate(client, input);
      const result = await client.query<{
        device_id: string;
        canonical_advertisement: string;
        canonical_request_proof: string;
      }>(
        `select c.device_id,c.canonical_advertisement,c.canonical_request_proof from pds_configuration_capabilities c
        join personal_device_group_members m on m.group_id=c.group_id and m.device_id=c.device_id and m.status='active'
        where c.group_id=$1 and c.device_id<>$2 and c.expires_at>now() order by c.device_id limit 64`,
        [auth.groupDbId, auth.deviceId]
      );
      await client.query("commit");
      return result.rows.map((row) => ({
        deviceId: row.device_id,
        canonicalAdvertisement: row.canonical_advertisement,
        canonicalRequestProof: row.canonical_request_proof
      }));
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
});

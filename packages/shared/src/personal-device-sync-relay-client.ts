import { randomBytes, sign, type KeyObject } from "node:crypto";
import {
  PDS_PROTOCOL,
  decodePdsBase64url,
  pdsEd25519PrivateKey
} from "./personal-device-sync.js";
import { canonicalizePdsJson } from "./personal-device-sync-jcs.js";
import {
  pdsRelayBodyDigest,
  pdsRelayRequestSigningBytes
} from "./personal-device-sync-relay.js";
import { isPrivateNetworkIpv4Address } from "./private-network.js";
import type {
  PdsSessionPackage,
  PdsSessionPackageChunk
} from "./personal-device-session-package.js";

export interface PdsRelayClientIdentity {
  certificate: string;
  deviceId: string;
  signingKeyId: string;
  signingPublicKey: string;
  signingPrivateSeed: string | Buffer;
}

export interface PdsRelayClientOptions {
  baseUrl: string;
  identity: PdsRelayClientIdentity;
  fetch?: typeof fetch;
}

export interface PdsRelaySemanticWorkClaim {
  workIdentity: string;
  workClass: "projection" | "memory_embedding" | "lcm_leaf" | "lcm_rollup";
  compatibilityContractHash: string;
  claimantDeviceId: string;
  claimGeneration: string;
  claimedAt: string;
  expiresAt: string;
}

export interface PdsRelayDeviceCapabilityAdvertisement {
  capability: "projection" | "memory_embedding" | "lcm";
  compatibilityContractHash: string;
  readiness: "ready" | "busy" | "unavailable";
  advertisedAt: string;
  expiresAt: string;
}

const relayPath = "/v1/personal-device-sync/relay";

export const normalizePdsRelayBaseUrl = (value: string): string => {
  if (value.length > 2_048) {
    throw new TypeError("PDS relay URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("PDS relay URL is invalid");
  }
  const privateHttpOrigin =
    /^http:\/\/([^/:?#]+)(?::([1-9][0-9]{0,4}))?(?:\/|$)/.exec(value);
  const privateHttpAllowed =
    url.protocol === "http:" &&
    privateHttpOrigin?.[1] === url.hostname &&
    (url.hostname === "localhost" || isPrivateNetworkIpv4Address(url.hostname));
  const pathSegments = url.pathname.split("/").filter(Boolean);
  const pathAllowed =
    pathSegments.every(
      (segment) =>
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9._~-]+$/.test(segment)
    ) &&
    !/%2e/i.test(value) &&
    !/\/\.{1,2}(?:\/|$)/.test(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !pathAllowed ||
    (url.protocol !== "https:" && !privateHttpAllowed)
  ) {
    throw new TypeError(
      "PDS relay URL must use HTTPS or a private IPv4 HTTP origin"
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("PDS relay response is invalid");
  }
  return value as Record<string, unknown>;
};

/** Signed, canonical relay transport. Credentials never enter query strings. */
export class PdsRelayClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly identity: PdsRelayClientIdentity;
  private readonly signingKey: KeyObject;

  constructor(options: PdsRelayClientOptions) {
    this.baseUrl = normalizePdsRelayBaseUrl(options.baseUrl);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.identity = options.identity;
    decodePdsBase64url(this.identity.deviceId, 16);
    decodePdsBase64url(this.identity.signingKeyId, 16);
    this.signingKey = pdsEd25519PrivateKey(
      this.identity.signingPrivateSeed,
      this.identity.signingPublicKey
    );
  }

  private async response(
    method: "GET" | "POST" | "PUT",
    target: string,
    payload?: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    const body =
      payload === undefined
        ? Buffer.alloc(0)
        : Buffer.from(canonicalizePdsJson(payload), "utf8");
    const timestamp = new Date().toISOString();
    const nonce = randomBytes(32).toString("base64url");
    const unsigned = {
      deviceId: this.identity.deviceId,
      deviceSigningKeyId: this.identity.signingKeyId,
      timestamp,
      nonce,
      bodyDigest: pdsRelayBodyDigest(body)
    };
    const proof = {
      protocol: PDS_PROTOCOL,
      ...unsigned,
      signature: sign(
        null,
        pdsRelayRequestSigningBytes({ ...unsigned, method, target }),
        this.signingKey
      ).toString("base64url")
    };
    const response = await this.fetcher(`${this.baseUrl}${target}`, {
      method,
      headers: {
        accept: "application/json",
        ...(payload === undefined
          ? {}
          : { "content-type": "application/json" }),
        "x-pds-membership-certificate": Buffer.from(
          this.identity.certificate,
          "utf8"
        ).toString("base64url"),
        "x-pds-relay-proof": Buffer.from(
          canonicalizePdsJson(proof),
          "utf8"
        ).toString("base64url")
      },
      ...(payload === undefined ? {} : { body }),
      signal
    });
    if (!response.ok) {
      throw Object.assign(
        new Error(`PDS relay request failed: ${response.status}`),
        {
          name:
            response.status >= 500 || response.status === 429
              ? "PdsRelayRetryableError"
              : "PdsRelayRejectedError",
          transient: response.status >= 500 || response.status === 429
        }
      );
    }
    return response;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT",
    target: string,
    payload?: unknown
  ): Promise<T> {
    return (await (await this.response(method, target, payload)).json()) as T;
  }

  async initialize(
    pkg: PdsSessionPackage
  ): Promise<{ transportId: string; missingChunks: string[] }> {
    const response = asRecord(
      await this.request<unknown>("POST", `${relayPath}/transports`, {
        header: pkg.header,
        envelopes: pkg.envelopes
      })
    );
    const transport = asRecord(response.transport);
    if (
      typeof transport.transportId !== "string" ||
      !Array.isArray(transport.missingChunks)
    ) {
      throw new TypeError("PDS relay initialization response is invalid");
    }
    return {
      transportId: transport.transportId,
      missingChunks: transport.missingChunks as string[]
    };
  }

  async uploadChunk(
    transportId: string,
    chunk: PdsSessionPackageChunk
  ): Promise<string[]> {
    const response = asRecord(
      await this.request<unknown>(
        "PUT",
        `${relayPath}/transports/${encodeURIComponent(transportId)}/chunks/${encodeURIComponent(chunk.chunkIndex)}`,
        chunk
      )
    );
    if (!Array.isArray(response.missingChunks))
      throw new TypeError("PDS relay chunk response is invalid");
    return response.missingChunks as string[];
  }

  async commit(pkg: PdsSessionPackage): Promise<{
    transportId: string;
    deliveryState: "committed" | "acked";
  }> {
    const response = asRecord(
      await this.request<unknown>(
        "POST",
        `${relayPath}/transports/${encodeURIComponent(pkg.header.transportId)}/commit`,
        { packageDigest: pkg.packageDigest }
      )
    );
    const transport = asRecord(response.transport);
    if (
      typeof transport.transportId !== "string" ||
      (transport.deliveryState !== "pending" &&
        transport.deliveryState !== "acked")
    )
      throw new TypeError("PDS relay commit response is invalid");
    return {
      transportId: transport.transportId,
      deliveryState: transport.deliveryState === "acked" ? "acked" : "committed"
    };
  }

  async upload(pkg: PdsSessionPackage): Promise<{
    transportId: string;
    deliveryState: "committed" | "acked";
  }> {
    const initialized = await this.initialize(pkg);
    const missing = new Set(initialized.missingChunks);
    for (const chunk of pkg.chunks) {
      if (missing.has(chunk.chunkIndex))
        await this.uploadChunk(initialized.transportId, chunk);
    }
    return this.commit(pkg);
  }

  async acquireSemanticWorkClaim(input: {
    workIdentity: string;
    workClass: PdsRelaySemanticWorkClaim["workClass"];
    compatibilityContractHash: string;
    leaseSeconds?: number;
  }): Promise<PdsRelaySemanticWorkClaim | null> {
    const response = asRecord(
      await this.request<unknown>(
        "POST",
        `${relayPath}/semantic-work/claims/acquire`,
        {
          ...input,
          leaseSeconds: input.leaseSeconds ?? 60
        }
      )
    );
    if (response.claim === null) return null;
    const claim = asRecord(response.claim);
    for (const key of [
      "workIdentity",
      "workClass",
      "compatibilityContractHash",
      "claimantDeviceId",
      "claimGeneration",
      "claimedAt",
      "expiresAt"
    ]) {
      if (typeof claim[key] !== "string") {
        throw new TypeError("PDS semantic work claim response is invalid");
      }
    }
    return claim as unknown as PdsRelaySemanticWorkClaim;
  }

  async advertiseSemanticCapability(
    input: PdsRelayDeviceCapabilityAdvertisement
  ): Promise<boolean> {
    const response = asRecord(
      await this.request<unknown>(
        "POST",
        `${relayPath}/semantic-work/capabilities`,
        input
      )
    );
    if (typeof response.accepted !== "boolean") {
      throw new TypeError("PDS semantic capability response is invalid");
    }
    return response.accepted;
  }

  async completeSemanticWorkClaim(input: {
    workIdentity: string;
    claimGeneration: string;
  }): Promise<boolean> {
    const response = asRecord(
      await this.request<unknown>(
        "POST",
        `${relayPath}/semantic-work/claims/complete`,
        input
      )
    );
    if (typeof response.completed !== "boolean") {
      throw new TypeError("PDS semantic work completion response is invalid");
    }
    return response.completed;
  }

  mailbox(cursor?: string, limit = 50): Promise<unknown> {
    const query = new URLSearchParams({
      limit: String(Math.min(Math.max(limit, 1), 100))
    });
    if (cursor) query.set("cursor", cursor);
    return this.request("GET", `${relayPath}/mailbox?${query.toString()}`);
  }

  async waitForWake(
    signal?: AbortSignal,
    pendingTransportIds: string[] = []
  ): Promise<void> {
    const query = new URLSearchParams();
    for (const transportId of pendingTransportIds.slice(0, 100)) {
      query.append("transportId", transportId);
    }
    const target = `${relayPath}/wake${query.size ? `?${query.toString()}` : ""}`;
    await (await this.response("GET", target, undefined, signal)).json();
  }

  transport(transportId: string): Promise<unknown> {
    return this.request(
      "GET",
      `${relayPath}/transports/${encodeURIComponent(transportId)}`
    );
  }

  chunk(transportId: string, chunkIndex: string): Promise<unknown> {
    return this.request(
      "GET",
      `${relayPath}/transports/${encodeURIComponent(transportId)}/chunks/${encodeURIComponent(chunkIndex)}`
    );
  }

  acknowledge(ack: unknown): Promise<unknown> {
    return this.request("POST", `${relayPath}/acks`, ack);
  }

  certificate(): Promise<unknown> {
    return this.request("GET", `${relayPath}/certificate`);
  }

  lifecycle(cursor?: string, limit = 50): Promise<unknown> {
    const query = new URLSearchParams({
      limit: String(Math.min(Math.max(limit, 1), 100))
    });
    if (cursor) query.set("cursor", cursor);
    return this.request("GET", `${relayPath}/lifecycle?${query.toString()}`);
  }

  acknowledgeTombstone(ack: unknown): Promise<unknown> {
    return this.request("POST", `${relayPath}/tombstone-acks`, ack);
  }

  cursors(): Promise<unknown> {
    return this.request("GET", `${relayPath}/cursors`);
  }

  advanceCursor(originDeviceId: string, sequence: string): Promise<unknown> {
    return this.request(
      "PUT",
      `${relayPath}/cursors/${encodeURIComponent(originDeviceId)}`,
      { sequence }
    );
  }
}

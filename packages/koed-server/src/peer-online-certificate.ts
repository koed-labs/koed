import "reflect-metadata";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  X509Certificate
} from "node:crypto";
// @peculiar/x509 has no independently verified audit for this use; review before deployment.
import {
  X509Certificate as ParsedCertificate,
  X509CertificateGenerator
} from "@peculiar/x509";

/**
 * Implementations must protect private material at rest, durably commit a
 * complete value, and provide atomic create-if-absent across all processes.
 * A missing value must not be reported for storage or decryption errors.
 */
export interface PeerOnlineCertificateStore {
  read(): Promise<string | null>;
  create(value: string): Promise<boolean>;
}

export interface PeerOnlineCertificate {
  certificate: string;
  privateKey: string;
  spkiPin: string;
}

function parseCertificate(value: string): PeerOnlineCertificate {
  try {
    const record: unknown = JSON.parse(value);
    if (!record || typeof record !== "object" || Array.isArray(record))
      throw new Error();
    const data = record as Record<string, unknown>;
    if (
      Object.keys(data).length !== 3 ||
      data.version !== 1 ||
      typeof data.certificate !== "string" ||
      typeof data.privateKey !== "string"
    )
      throw new Error();
    const certificate = new X509Certificate(data.certificate);
    const key = createPrivateKey(data.privateKey);
    const publicKey = certificate.publicKey;
    const spki = publicKey.export({ type: "spki", format: "der" });
    const now = Date.now();
    if (
      key.asymmetricKeyType !== "ec" ||
      key.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
      !spki.equals(
        createPublicKey(key).export({ type: "spki", format: "der" })
      ) ||
      certificate.subject !== certificate.issuer ||
      !certificate.verify(publicKey) ||
      new ParsedCertificate(data.certificate).extensions.length !== 0 ||
      Date.parse(certificate.validFrom) > now ||
      Date.parse(certificate.validTo) <= now
    )
      throw new Error();
    return {
      certificate: data.certificate,
      privateKey: data.privateKey,
      spkiPin: createHash("sha256").update(spki).digest("base64url")
    };
  } catch {
    throw new Error(
      "Peer online certificate is corrupt, expired, or incomplete."
    );
  }
}

/** Load only. Missing custody state is an error, never a request to regenerate. */
export async function loadPeerOnlineCertificate(
  store: PeerOnlineCertificateStore
): Promise<PeerOnlineCertificate> {
  const value = await store.read();
  if (value === null) throw new Error("Peer online certificate is missing.");
  return parseCertificate(value);
}

/**
 * Provision only after an independent authority confirms a fresh installation.
 * Local storage absence cannot distinguish first use from loss or rollback.
 * Loaded pins must be bound to trusted enrollment before use.
 */
export async function createPeerOnlineCertificate(
  store: PeerOnlineCertificateStore,
  authorizeFreshInstallation: () => Promise<boolean>
): Promise<PeerOnlineCertificate> {
  const existing = await store.read();
  if (existing !== null) return parseCertificate(existing);
  if (
    typeof authorizeFreshInstallation !== "function" ||
    (await authorizeFreshInstallation()) !== true
  )
    throw new Error("Fresh installation authorization required.");
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const now = Date.now();
  const cert = await X509CertificateGenerator.createSelfSigned({
    name: "CN=Koed Peer Online",
    keys,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 10 * 365 * 24 * 60 * 60 * 1000)
  });
  const privateKey = createPrivateKey({
    key: Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
    format: "der",
    type: "pkcs8"
  })
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const value = JSON.stringify({
    version: 1,
    certificate: cert.toString("pem"),
    privateKey
  });
  const result = parseCertificate(value);
  if (await store.create(value)) return result;
  return loadPeerOnlineCertificate(store);
}

import {
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
  verify
} from "node:crypto";

/**
 * UNUSED protocol core, not safe to expose on a network. Trusted endpoint authentication,
 * confidential transport, PAKE, session persistence, cross-process coordination and restart
 * recovery are not provided. The join contains the code in plaintext: protect it from
 * disclosure, including logs. Excluding it from the signature avoids one offline oracle,
 * but also allows its substitution without channel integrity. The endpoint and offer are
 * not authenticated here.
 * The caller must supply a genuine local authenticated context and a fail-closed authorization
 * callback; untrusted callers must never choose or forge that context. Callers must enforce
 * global and per-principal rate limits. X25519 possession is not proved.
 *
 * A commit timeout is indeterminate, not a rollback: its callback can still commit later.
 * Reconcile durable state before any new attempt; never retry the same attempt. The caller
 * must bound underlying transaction resources and enforce deadlines independently.
 *
 * The commit callback must atomically recheck initiator/group authorization and expiry,
 * prevent duplicate admission across processes/restarts, and commit membership and any
 * returned secret material in one durable transaction. It must reject on rollback or an
 * uncertain outcome. This core consumes the attempt even on callback failure; never retry
 * a failed or indeterminate commit with the same attempt.
 */
export interface PairingOffer {
  id: string;
  token: string;
  groupId: string;
  initiatorId: string;
  initiatorKey: string;
  expiresAt: number;
}

export interface PairingJoin {
  deviceId: string;
  signingKey: string;
  encryptionKey: string;
  code: string;
  signature: string;
}

export interface PairingCommit {
  attemptId: string;
  groupId: string;
  initiatorId: string;
  initiatorKey: string;
  expiresAt: number;
  deviceId: string;
  signingKey: string;
  encryptionKey: string;
}

interface Attempt {
  offer: PairingOffer;
  join?: PairingJoin;
  state: "open" | "committing" | "used";
  joinFailures: number;
  guesses: number;
  lastJoin?: number;
  lastGuess?: number;
}

const ttl = 120_000;
const interval = 1_000;
const limit = 5;
const capacity = 1_000;
const validText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4096;
const digest = (value: string) => createHash("sha256").update(value).digest();

/** Joiner generates this locally using a cryptographically secure random source. */
export function generatePairingCode(): string {
  return randomInt(1_000_000).toString().padStart(6, "0");
}

/** Versioned, ordered JSON array; signature field itself is excluded. */
export function pairingTranscript(
  offer: PairingOffer,
  join: PairingJoin
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "koed-peer-online-pairing-v2",
      offer.id,
      offer.token,
      offer.groupId,
      offer.initiatorId,
      offer.initiatorKey,
      offer.expiresAt,
      join.deviceId,
      join.signingKey,
      join.encryptionKey
    ]),
    "utf8"
  );
}

export class PairingAttempts<T> {
  private readonly attempts = new Map<string, Attempt>();
  private readonly now: () => number;
  private readonly commit: (input: PairingCommit) => Promise<T>;
  private readonly authorizeLocal: (
    context: unknown,
    action: "create" | "approve",
    identity: { groupId: string; initiatorId: string; initiatorKey: string }
  ) => boolean;

  constructor(options: {
    now?: () => number;
    authorizeLocal: (
      context: unknown,
      action: "create" | "approve",
      identity: { groupId: string; initiatorId: string; initiatorKey: string }
    ) => boolean;
    commit: (input: PairingCommit) => Promise<T>;
  }) {
    this.now = options.now ?? Date.now;
    if (typeof options.authorizeLocal !== "function")
      throw new Error("Local authorization required");
    this.authorizeLocal = options.authorizeLocal;
    this.commit = options.commit;
  }

  create(
    input: {
      groupId: string;
      initiatorId: string;
      initiatorKey: string;
    },
    context?: unknown
  ): PairingOffer {
    if (
      ![input.groupId, input.initiatorId, input.initiatorKey].every(validText)
    )
      throw new Error("Invalid pairing identity");
    this.authorize(context, "create", input);
    const now = this.now();
    for (const [id, attempt] of this.attempts) {
      if (
        attempt.state !== "committing" &&
        (attempt.state === "used" || now >= attempt.offer.expiresAt)
      )
        this.attempts.delete(id);
    }
    if (this.attempts.size >= capacity)
      throw new Error("Pairing capacity exceeded");
    const offer = {
      ...input,
      id: randomBytes(32).toString("base64url"),
      token: randomBytes(32).toString("base64url"),
      expiresAt: now + ttl
    };
    this.attempts.set(offer.id, {
      offer: { ...offer },
      state: "open",
      joinFailures: 0,
      guesses: 0
    });
    return offer;
  }

  join(offer: PairingOffer, join: PairingJoin): void {
    const attempt = this.active(offer?.id);
    const expected = attempt.offer;
    if (
      typeof offer.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(offer.token) ||
      !timingSafeEqual(digest(offer.token), digest(expected.token))
    )
      throw new Error("Invalid pairing offer");
    const now = this.now();
    if (
      attempt.join ||
      attempt.joinFailures >= limit ||
      (attempt.lastJoin !== undefined && now - attempt.lastJoin < interval)
    )
      throw new Error("Pairing join unavailable");
    attempt.lastJoin = now;
    attempt.joinFailures++;
    if (
      !join ||
      ![
        join.deviceId,
        join.signingKey,
        join.encryptionKey,
        join.signature
      ].every(validText) ||
      typeof join.code !== "string" ||
      !/^\d{6}$/.test(join.code)
    )
      throw new Error("Invalid pairing join");
    if (
      offer.groupId !== expected.groupId ||
      offer.initiatorId !== expected.initiatorId ||
      offer.initiatorKey !== expected.initiatorKey ||
      offer.expiresAt !== expected.expiresAt
    )
      throw new Error("Invalid pairing offer");
    try {
      const key = createPublicKey({
        key: Buffer.from(join.signingKey, "base64url"),
        type: "spki",
        format: "der"
      });
      const encryptionKey = createPublicKey({
        key: Buffer.from(join.encryptionKey, "base64url"),
        type: "spki",
        format: "der"
      });
      if (
        key.asymmetricKeyType !== "ed25519" ||
        encryptionKey.asymmetricKeyType !== "x25519" ||
        !verify(
          null,
          pairingTranscript(expected, join),
          key,
          Buffer.from(join.signature, "base64url")
        )
      )
        throw new Error("Invalid proof");
      // OpenSSL rejects low-order X25519 inputs that yield an all-zero secret.
      // This checks key usability, not possession of the corresponding private key.
      const sharedSecret = diffieHellman({
        privateKey: generateKeyPairSync("x25519").privateKey,
        publicKey: encryptionKey
      });
      if (sharedSecret.every((byte) => byte === 0))
        throw new Error("Invalid proof");
    } catch {
      throw new Error("Invalid pairing proof");
    }
    attempt.join = { ...join };
  }

  async approve(id: string, code: string, context?: unknown): Promise<T> {
    const attempt = this.active(id);
    this.authorize(context, "approve", attempt.offer);
    if (this.active(id) !== attempt)
      throw new Error("Pairing attempt unavailable");
    const now = this.now();
    if (
      !attempt.join ||
      attempt.guesses >= limit ||
      (attempt.lastGuess !== undefined && now - attempt.lastGuess < interval)
    )
      throw new Error("Pairing approval unavailable");
    attempt.lastGuess = now;
    attempt.guesses++;
    const supplied =
      typeof code === "string" && code.length <= 4096 ? code : "";
    if (!timingSafeEqual(digest(supplied), digest(attempt.join.code)))
      throw new Error("Invalid pairing code");
    attempt.state = "committing";
    const { offer, join } = attempt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Pairing commit outcome indeterminate")),
          30_000
        );
      });
      return await Promise.race([
        this.commit({
          attemptId: offer.id,
          groupId: offer.groupId,
          initiatorId: offer.initiatorId,
          initiatorKey: offer.initiatorKey,
          expiresAt: offer.expiresAt,
          deviceId: join.deviceId,
          signingKey: join.signingKey,
          encryptionKey: join.encryptionKey
        }),
        timeout
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      attempt.state = "used";
      attempt.join = undefined;
    }
  }

  private authorize(
    context: unknown,
    action: "create" | "approve",
    identity: { groupId: string; initiatorId: string; initiatorKey: string }
  ): void {
    const { groupId, initiatorId, initiatorKey } = identity;
    if (
      this.authorizeLocal(context, action, {
        groupId,
        initiatorId,
        initiatorKey
      }) !== true
    )
      throw new Error("Local authorization required");
  }

  private active(id: string): Attempt {
    const attempt = this.attempts.get(id);
    if (
      !attempt ||
      attempt.state !== "open" ||
      this.now() >= attempt.offer.expiresAt
    )
      throw new Error("Pairing attempt unavailable");
    return attempt;
  }
}

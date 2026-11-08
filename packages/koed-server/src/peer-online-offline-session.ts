export type OfflineCheckpoint = {
  bindingJson: string;
  envelope: string;
  payload: Uint8Array;
};
export type OfflineSessionContext = {
  peerDeviceId: string;
  membershipRevision: string;
};
export type OfflineAck = { sessionKey: string; sequence: string; hash: string };
export type OfflineReceiveResult =
  | { status: "accepted" | "duplicate"; ack: OfflineAck }
  | { status: "pending" | "deleted" | "invalid" | "quota_exceeded" | "fenced" };

export interface OfflineChannel {
  // Unique identity reserved exclusively for operations cancelled by local close.
  readonly localCloseError?: Error;
  receive(): Promise<Buffer | null>;
  send(payload: Uint8Array): Promise<void>;
  close(): void;
}

// The codec must reject unknown wire fields and wire-supplied session context.
export interface OfflineCodec {
  decode(frame: Uint8Array): OfflineCheckpoint;
  encodeAck(ack: OfflineAck): Uint8Array;
}

export interface OfflineSessionOptions {
  session: Readonly<OfflineSessionContext>;
  channel: OfflineChannel;
  receiver: {
    receive(
      input: OfflineCheckpoint,
      sessionContext: OfflineSessionContext | undefined
    ): Promise<OfflineReceiveResult>;
  };
  codec: OfflineCodec;
  maxFrameBytes: number;
  onError(error: unknown): void;
}

export type OfflineSessionOutcome = void | {
  status: "pending" | "deleted" | "invalid" | "quota_exceeded" | "fenced";
};

export interface OfflineSession {
  readonly done: Promise<OfflineSessionOutcome>;
  close(): Promise<OfflineSessionOutcome>;
}

function validateCheckpoint(
  value: unknown
): asserts value is OfflineCheckpoint {
  if (
    !value ||
    typeof value !== "object" ||
    Reflect.ownKeys(value).length !== 3 ||
    !Object.hasOwn(value, "bindingJson") ||
    !Object.hasOwn(value, "envelope") ||
    !Object.hasOwn(value, "payload")
  ) {
    throw new Error("Invalid decoded checkpoint");
  }
  const checkpoint = value as OfflineCheckpoint;
  if (
    typeof checkpoint.bindingJson !== "string" ||
    typeof checkpoint.envelope !== "string" ||
    !(checkpoint.payload instanceof Uint8Array)
  ) {
    throw new Error("Invalid decoded checkpoint");
  }
}

function validAck(value: unknown): value is OfflineAck {
  if (!value || typeof value !== "object") return false;
  const ack = value as OfflineAck;
  return (
    typeof ack.sessionKey === "string" &&
    typeof ack.sequence === "string" &&
    typeof ack.hash === "string"
  );
}

export function startOfflineSession(
  options: OfflineSessionOptions
): OfflineSession {
  if (!Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes < 1)
    throw new RangeError("Invalid frame limit");
  const context = {
    peerDeviceId: options.session.peerDeviceId,
    membershipRevision: options.session.membershipRevision
  };
  let closing = false;
  function report(error: unknown) {
    try {
      options.onError(error);
    } catch (callbackError) {
      process.emitWarning(
        `Offline session error callback failed: ${String(callbackError)}`
      );
    }
  }
  function stop() {
    if (closing) return;
    closing = true;
    try {
      options.channel.close();
    } catch (error) {
      report(error);
    }
  }
  async function channelOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        closing &&
        options.channel.localCloseError &&
        error === options.channel.localCloseError
      )
        throw localCancellation;
      throw error;
    }
  }
  const localCancellation = Symbol("local cancellation");
  async function run(): Promise<OfflineSessionOutcome> {
    try {
      while (!closing) {
        const frame = await channelOperation(() => options.channel.receive());
        if (closing || frame === null) break;
        if (frame.byteLength === 0 || frame.byteLength > options.maxFrameBytes)
          throw new Error("Invalid frame size");
        const checkpoint = options.codec.decode(frame);
        validateCheckpoint(checkpoint);
        const result = await options.receiver.receive(checkpoint, {
          ...context
        });
        if (!result || typeof result !== "object")
          throw new Error("Invalid receiver result");
        if (result.status !== "accepted" && result.status !== "duplicate") {
          if (
            ![
              "pending",
              "deleted",
              "invalid",
              "quota_exceeded",
              "fenced"
            ].includes(result.status)
          )
            throw new Error("Invalid receiver result");
          return { status: result.status };
        }
        if (closing) break;
        if (!validAck(result.ack)) throw new Error("Invalid receiver ACK");
        const encoded = options.codec.encodeAck(result.ack);
        if (closing) break;
        await channelOperation(() => options.channel.send(encoded));
      }
    } catch (error) {
      if (error !== localCancellation) report(error);
    } finally {
      stop();
    }
  }
  const done = run();
  return {
    done,
    close() {
      stop();
      return done;
    }
  };
}

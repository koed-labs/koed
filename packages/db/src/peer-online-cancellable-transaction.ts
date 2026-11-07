import type pg from "pg";

const LOCK_TIMEOUT = "5s";
const STATEMENT_TIMEOUT = "10s";
const MAX_PEER_ONLINE_CONNECTION_TIMEOUT_MILLIS = 10_000;

type TransactionAction<T> = (client: pg.PoolClient) => Promise<T>;

export function peerOnlineAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(
    typeof reason === "string" ? reason : "Peer Online database lookup aborted"
  );
  error.name = "AbortError";
  return error;
}

export function throwIfPeerOnlineAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw peerOnlineAbortError(signal);
}

export function assertPeerOnlinePoolBounded(pool: pg.Pool): void {
  const timeout = pool.options.connectionTimeoutMillis;
  if (
    typeof timeout !== "number" ||
    !Number.isInteger(timeout) ||
    timeout <= 0 ||
    timeout > MAX_PEER_ONLINE_CONNECTION_TIMEOUT_MILLIS
  )
    throw new Error(
      `Peer Online membership lookup requires connectionTimeoutMillis from 1 to ${MAX_PEER_ONLINE_CONNECTION_TIMEOUT_MILLIS}`
    );
}

async function connectWithSignal(
  pool: pg.Pool,
  signal: AbortSignal
): Promise<pg.PoolClient> {
  throwIfPeerOnlineAborted(signal);
  assertPeerOnlinePoolBounded(pool);
  const pending = pool.connect();
  return new Promise((resolve, reject) => {
    let settled = false;
    const removeAbortListener = () =>
      signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      reject(peerOnlineAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void pending.then(
      (client) => {
        if (settled || signal.aborted) {
          client.release(peerOnlineAbortError(signal));
          return;
        }
        settled = true;
        removeAbortListener();
        resolve(client);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        removeAbortListener();
        reject(
          error instanceof Error
            ? error
            : new Error("PostgreSQL pool acquisition failed", { cause: error })
        );
      }
    );
  });
}

async function runTransaction<T>(
  client: pg.PoolClient,
  groupId: string,
  run: TransactionAction<T>,
  signal: AbortSignal
): Promise<T> {
  let started = false;
  try {
    await client.query("begin isolation level read committed");
    started = true;
    await client.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
    throwIfPeerOnlineAborted(signal);
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`koed:peer-online-membership:${groupId}`]
    );
    throwIfPeerOnlineAborted(signal);
    const result = await run(client);
    throwIfPeerOnlineAborted(signal);
    await client.query("commit");
    started = false;
    return result;
  } catch (error) {
    if (started && !signal.aborted) await client.query("rollback");
    throw error;
  }
}

export async function cancellablePeerOnlineTransaction<T>(
  pool: pg.Pool,
  groupId: string,
  run: TransactionAction<T>,
  signal: AbortSignal
): Promise<T> {
  const client = await connectWithSignal(pool, signal);
  let released = false;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    const error = peerOnlineAbortError(signal);
    rejectAbort(error);
    if (!released) {
      released = true;
      client.release(error);
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfPeerOnlineAborted(signal);
    return await Promise.race([
      runTransaction(client, groupId, run, signal),
      aborted
    ]);
  } catch (error) {
    if (signal.aborted) throw peerOnlineAbortError(signal);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!released) client.release();
  }
}

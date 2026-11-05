/*
 * Peer-online local control is deliberately unavailable, including outside
 * production. Node's pathname-bound Unix listener unlinks its bind path on
 * close, even if another object replaced the socket. Node exposes no supported
 * way to detach that unlink, so safe listener cleanup cannot be guaranteed.
 *
 * A future implementation could use a native binder that passes an already-bound
 * descriptor to Node and never automatically unlinks its pathname. Any such control
 * channel trusts all processes running as the same OS user; filesystem modes
 * do not authenticate peers of that user. Handlers must cooperatively honor an
 * AbortSignal and release their own resources; JavaScript cannot force their
 * cancellation. No listener, handler or request is enabled by this module.
 */

type Options = {
  timeoutMs?: number;
  maxFrameBytes?: number;
  maxConcurrency?: number;
};

type Handler = (
  request: unknown,
  signal: AbortSignal
) => unknown | Promise<unknown>;

const unavailable = () =>
  new Error(
    "Peer-online local control is unavailable: safe Unix socket lifecycle is not implemented"
  );

export function startPeerOnlineControl(
  _dir: string,
  _handler: Handler,
  _options: Options = {}
): Promise<{ close(): Promise<void> }> {
  return Promise.reject(unavailable());
}

export function requestPeerOnlineControl(
  _dir: string,
  _request: unknown,
  _options: Options = {}
): Promise<unknown> {
  return Promise.reject(unavailable());
}

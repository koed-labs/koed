import type { AuthenticatedControlPeer } from "./handshake.js";

/** A transport connection supplied only after native peer authentication. */
export interface ControlConnection {
  readonly peer: AuthenticatedControlPeer;
  send(message: string): Promise<void>;
  onMessage(listener: (message: string) => void): () => void;
  onEnd(listener: () => void): () => void;
  onClose(listener: (error?: string) => void): () => void;
  close(): void;
}

export interface ControlListener {
  onError(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export interface ControlTransport {
  connect(path: string): Promise<ControlConnection>;
  listen(
    path: string,
    accept: (connection: ControlConnection) => void
  ): Promise<ControlListener>;
}

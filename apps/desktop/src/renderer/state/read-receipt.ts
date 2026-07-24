export type ReadViewportState = {
  atEnd: boolean;
  hasNewer: boolean;
  lastVisibleId: string | null;
};

export type ReadReceiptInput = ReadViewportState & {
  documentVisible: boolean;
  finalUnreadId: string | null;
  windowFocused: boolean;
};

export class ReadReceiptController {
  readonly #dwellMs: number;
  readonly #markRead: (messageId: string) => Promise<void>;
  #acknowledgedId: string | null = null;
  #candidateId: string | null = null;
  #inFlightId: string | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    dwellMs?: number;
    markRead: (messageId: string) => Promise<void>;
  }) {
    this.#dwellMs = options.dwellMs ?? 500;
    this.#markRead = options.markRead;
  }

  update(input: ReadReceiptInput): void {
    const eligible =
      input.documentVisible &&
      input.windowFocused &&
      input.atEnd &&
      !input.hasNewer &&
      input.finalUnreadId !== null &&
      input.lastVisibleId === input.finalUnreadId;
    const candidate = eligible ? input.finalUnreadId : null;

    if (
      candidate &&
      (candidate === this.#acknowledgedId ||
        candidate === this.#inFlightId ||
        candidate === this.#candidateId)
    ) {
      return;
    }
    this.#cancelTimer();
    this.#candidateId = candidate;
    if (!candidate) return;

    this.#timer = setTimeout(() => {
      this.#timer = null;
      const messageId = this.#candidateId;
      this.#candidateId = null;
      if (!messageId) return;
      this.#inFlightId = messageId;
      void this.#markRead(messageId)
        .then(() => {
          this.#acknowledgedId = messageId;
        })
        .catch(() => undefined)
        .finally(() => {
          if (this.#inFlightId === messageId) this.#inFlightId = null;
        });
    }, this.#dwellMs);
  }

  reset(): void {
    this.#cancelTimer();
    this.#candidateId = null;
    this.#inFlightId = null;
    this.#acknowledgedId = null;
  }

  dispose(): void {
    this.#cancelTimer();
  }

  #cancelTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

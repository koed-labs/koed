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
  #disposed = false;
  #inFlightId: string | null = null;
  #latestInput: ReadReceiptInput | null = null;
  #retryCount = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    dwellMs?: number;
    markRead: (messageId: string) => Promise<void>;
  }) {
    this.#dwellMs = options.dwellMs ?? 500;
    this.#markRead = options.markRead;
  }

  update(input: ReadReceiptInput): void {
    if (this.#disposed) return;
    this.#latestInput = input;
    const candidate = this.#eligibleCandidate(input);

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
    if (!candidate) {
      this.#retryCount = 0;
      return;
    }
    this.#schedule(candidate, this.#dwellMs);
  }

  #schedule(messageId: string, delayMs: number): void {
    if (this.#disposed) return;
    this.#candidateId = messageId;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const scheduledMessageId = this.#candidateId;
      this.#candidateId = null;
      if (!scheduledMessageId) return;
      this.#inFlightId = scheduledMessageId;
      void this.#markRead(scheduledMessageId)
        .then(() => {
          if (this.#disposed) return;
          this.#acknowledgedId = scheduledMessageId;
          this.#retryCount = 0;
        })
        .catch(() => {
          if (this.#disposed) return;
          const stillEligible =
            this.#latestInput &&
            this.#eligibleCandidate(this.#latestInput) === scheduledMessageId;
          if (stillEligible && this.#retryCount < 3) {
            this.#retryCount += 1;
            this.#schedule(
              scheduledMessageId,
              Math.min(250 * 2 ** (this.#retryCount - 1), 1_000)
            );
          }
        })
        .finally(() => {
          if (this.#inFlightId === scheduledMessageId) {
            this.#inFlightId = null;
          }
        });
    }, delayMs);
  }

  reset(): void {
    this.#cancelTimer();
    this.#candidateId = null;
    this.#inFlightId = null;
    this.#acknowledgedId = null;
    this.#latestInput = null;
    this.#retryCount = 0;
  }

  dispose(): void {
    this.#disposed = true;
    this.#cancelTimer();
    this.#candidateId = null;
    this.#inFlightId = null;
    this.#latestInput = null;
  }

  #cancelTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #eligibleCandidate(input: ReadReceiptInput): string | null {
    return input.documentVisible &&
      input.windowFocused &&
      input.atEnd &&
      !input.hasNewer &&
      input.finalUnreadId !== null &&
      input.lastVisibleId === input.finalUnreadId
      ? input.finalUnreadId
      : null;
  }
}

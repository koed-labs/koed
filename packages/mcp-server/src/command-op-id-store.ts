import { createHash } from "node:crypto";
import type { MemoryApiClient } from "./index.js";
import type {
  ManagedConversationControlActionResult,
  ManagedConversationControlActionState
} from "./managed-conversation-command-types.js";

const KOED_OP_ID_MARKER = "_koed_op_id_state";
const PAGE_LIMIT = 20;
const MAX_PAGES = 5;

type StoredState = Omit<
  ManagedConversationControlActionState,
  "operationId" | "actionId" | "executionGeneration"
>;

const isStoredStateStatus = (
  status: string
): status is StoredState["status"] => {
  return (
    status === "accepted" ||
    status === "rejected" ||
    status === "unknown" ||
    status === "pending"
  );
};

const resultToStoredState = (
  result: ManagedConversationControlActionResult
): StoredState => {
  if (result.status === "accepted" || result.status === "already_accepted") {
    return { status: "accepted", createdAt: new Date().toISOString() };
  }
  if (result.status === "unknown") {
    return { status: "unknown", createdAt: new Date().toISOString() };
  }
  if (result.status === "rejected" && result.reason) {
    return {
      status: "rejected",
      reason: result.reason,
      createdAt: new Date().toISOString()
    };
  }
  return { status: "unknown", createdAt: new Date().toISOString() };
};

const storedStateToResult = (
  state: StoredState
): ManagedConversationControlActionResult => {
  if (state.status === "accepted") {
    return { status: "accepted" };
  }
  if (state.status === "rejected") {
    return { status: "rejected", reason: state.reason ?? "unknown" };
  }
  return { status: "unknown" };
};

const makeOpIdPayload = (states: Record<string, StoredState>): string => {
  return JSON.stringify({
    [KOED_OP_ID_MARKER]: true,
    states
  });
};

const parseOpIdPayload = (
  content: string
): Record<string, StoredState> | null => {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    if (!parsed[KOED_OP_ID_MARKER]) return null;
    const rawStates = parsed.states;
    if (!rawStates || typeof rawStates !== "object" || Array.isArray(rawStates))
      return null;
    const states: Record<string, StoredState> = {};
    for (const [opId, s] of Object.entries(rawStates)) {
      if (!s || typeof s !== "object" || Array.isArray(s)) continue;
      const state = s as Record<string, unknown>;
      const status = state.status as string | undefined;
      if (!status || !isStoredStateStatus(status)) continue;
      states[opId] = {
        status,
        ...(state.reason !== undefined
          ? { reason: state.reason as string }
          : {}),
        ...(state.createdAt !== undefined
          ? { createdAt: state.createdAt as string }
          : {})
      } as StoredState;
    }
    return states;
  } catch {
    return null;
  }
};

export class CommandOpIdStore {
  private readonly memory: Map<string, ManagedConversationControlActionResult> =
    new Map();
  private artifactId: string | null = null;
  private restoring: Promise<void> | null = null;

  constructor(private readonly memoryClient: MemoryApiClient) {}

  private ensureRestoring(artifactId: string): Promise<void> {
    if (this.artifactId === artifactId) return Promise.resolve();
    if (!this.restoring) {
      this.restoring = this.doRestore(artifactId).finally(() => {
        this.restoring = null;
      });
    }
    return this.restoring;
  }

  private async doRestore(artifactId: string): Promise<void> {
    for (let page = 0; page < MAX_PAGES; page++) {
      const afterOffset = page * PAGE_LIMIT;
      let segments: { id: string }[];
      try {
        const result = await this.memoryClient.listConversationSourceSegments(
          artifactId,
          { afterOffset, limit: PAGE_LIMIT }
        );
        segments = (result.segments as { id: string }[]) ?? [];
      } catch {
        return; // Artifact doesn't exist or API error
      }
      if (segments.length === 0) return;

      for (const seg of segments) {
        try {
          const contentResult =
            await this.memoryClient.getConversationSourceSegmentContent(
              artifactId,
              seg.id
            );
          const contentObj = contentResult as Record<string, unknown>;
          const bytesBase64 =
            typeof contentObj.bytesBase64 === "string"
              ? contentObj.bytesBase64
              : typeof contentObj.content === "string"
                ? contentObj.content
                : undefined;
          if (!bytesBase64) continue;
          const plaintext = Buffer.from(bytesBase64, "base64").toString("utf8");
          const states = parseOpIdPayload(plaintext);
          if (states) {
            for (const [opId, state] of Object.entries(states)) {
              this.memory.set(opId, storedStateToResult(state));
            }
            return;
          }
        } catch {
          // Skip unreadable segments
        }
      }

      if (segments.length < PAGE_LIMIT) return;
    }
  }

  async save(artifactId: string): Promise<void> {
    if (this.memory.size === 0) return;
    const states: Record<string, StoredState> = {};
    for (const [opId, result] of this.memory) {
      states[opId] = resultToStoredState(result);
    }
    const content = makeOpIdPayload(states);
    const contentBytes = Buffer.from(content);
    const contentBase64 = contentBytes.toString("base64");
    const digest = createHash("sha256").update(contentBytes).digest("hex");

    try {
      const segments = await this.memoryClient.listConversationSourceSegments(
        artifactId,
        { afterOffset: 0, limit: PAGE_LIMIT }
      );
      const segmentCount =
        (segments.segments as Array<{ id: string }>)?.length ?? 0;
      // Use segment count as rough cursor position. The API may reject if cursor
      // doesn't match artifact state, but failure is silently ignored.
      await this.memoryClient.appendConversationSourceSegment(artifactId, {
        expectedProviderOffset: segmentCount,
        expectedProviderLine: 1,
        sourceEndOffset: segmentCount + 1,
        sourceEndLine: 1,
        plaintextDigest: digest,
        plaintextSize: contentBytes.length,
        bytesBase64: contentBase64,
        currentSourceLength: segmentCount + 1
      });
    } catch {
      // Silently fail — next restore will pick up latest
    }
  }

  async ensureArtifact(artifactId: string): Promise<void> {
    if (this.artifactId === artifactId) return;
    await this.ensureRestoring(artifactId);
    this.artifactId = artifactId;
  }

  get(operationId: string): ManagedConversationControlActionResult | undefined {
    return this.memory.get(operationId);
  }

  set(
    operationId: string,
    result: ManagedConversationControlActionResult
  ): void {
    this.memory.set(operationId, result);
  }

  has(operationId: string): boolean {
    return this.memory.has(operationId);
  }
}

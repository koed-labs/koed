import type { MemoryApiClient } from "./index.js";
import type {
  ManagedConversationControlActionResult,
  ManagedConversationControlActionState
} from "./managed-conversation-command-types.js";

const SEGMENT_KEY = "command_action_state";

const SEGMENT_CONTENT_VERSION = 1;

type StoredState = Omit<ManagedConversationControlActionState, "operationId" | "actionId" | "executionGeneration">;

interface CommandOpIdSegmentData {
  version: typeof SEGMENT_CONTENT_VERSION;
  states: Record<string, StoredState>;
}

const isCommandOpIdSegmentData = (
  value: unknown
): value is CommandOpIdSegmentData => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== SEGMENT_CONTENT_VERSION) return false;
  if (typeof v.states !== "object" || Array.isArray(v.states)) return false;
  return true;
};

const isValidStoredStateStatus = (status: string): status is StoredState["status"] => {
  return (
    status === "accepted" ||
    status === "rejected" ||
    status === "unknown" ||
    status === "pending"
  );
};

const resultToState = (
  _operationId: string,
  result: ManagedConversationControlActionResult
): StoredState => {
  if (result.status === "accepted") {
    return { status: "accepted", createdAt: new Date().toISOString() };
  }
  if (result.status === "already_accepted") {
    return { status: "accepted", createdAt: new Date().toISOString() };
  }
  if (result.status === "unknown") {
    return { status: "unknown", createdAt: new Date().toISOString() };
  }
  if (result.status === "rejected" && result.reason) {
    return { status: "rejected", reason: result.reason, createdAt: new Date().toISOString() };
  }
  return { status: "unknown", createdAt: new Date().toISOString() };
};

const stateToResult = (
  state: StoredState
): ManagedConversationControlActionResult => {
  if (state.status === "accepted") {
    return { status: "accepted" };
  }
  if (state.status === "rejected") {
    return { status: "rejected", reason: state.reason ?? "unknown" };
  }
  // "pending" and "unknown" map to "unknown" in result terms.
  return { status: "unknown" };
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
    try {
      const segments = await this.memoryClient.listConversationSourceSegments(
        artifactId,
        { afterOffset: 0, limit: 100 }
      );
      const segmentList = segments.segments as Record<string, unknown>[];
      for (const seg of segmentList) {
        const segId = seg.id;
        const key = seg.key;
        if (key !== SEGMENT_KEY || typeof segId !== "string") continue;
        const content = await this.memoryClient.getConversationSourceSegmentContent(
          artifactId,
          segId as string
        );
        const parsed = this.parseSegmentContent(
          typeof content.content === "string" ? content.content : undefined
        );
        if (parsed) {
          for (const [opId, state] of Object.entries(parsed.states)) {
            this.memory.set(opId, stateToResult(state));
          }
          return;
        }
      }
    } catch {
      // Artifact may not exist yet or API unavailable; silent fail.
    }
  }

  async save(artifactId: string): Promise<void> {
    if (this.memory.size === 0) return;
    const stateMap: CommandOpIdSegmentData["states"] = {};
    for (const [opId, result] of this.memory) {
      const state = resultToState(opId, result);
      stateMap[opId] = state;
    }
    const data: CommandOpIdSegmentData = {
      version: SEGMENT_CONTENT_VERSION,
      states: stateMap
    };
    await this.memoryClient
      .appendConversationSourceSegment(artifactId, {
        key: SEGMENT_KEY,
        content: JSON.stringify(data),
        id: SEGMENT_KEY
      })
      .catch(() => {
        // On conflict or failure, silent fail — next restore will reload.
      });
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

  private parseSegmentContent(
    content: string | undefined
  ): CommandOpIdSegmentData | null {
    if (!content) return null;
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!isCommandOpIdSegmentData(parsed)) return null;
      // Validate each state entry.
      for (const [opId, state] of Object.entries(parsed.states)) {
        const status = state.status;
        if (!isValidStoredStateStatus(status)) return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}

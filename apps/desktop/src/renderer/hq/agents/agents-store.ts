import type { Agent } from "@koed/shared";
import type { AgentsDesktopApi } from "../../../ipc/agents-protocol.js";

export type AgentsSnapshot = Readonly<{
  ownerId: string | null;
  profileKey: string | null;
  agents: readonly Agent[];
  selectedAgentId: string | null;
  loading: boolean;
  error: string | null;
}>;

const empty = (
  ownerId: string | null,
  profileKey: string | null
): AgentsSnapshot => ({
  ownerId,
  profileKey,
  agents: [],
  selectedAgentId: null,
  loading: false,
  error: null
});

/** HQ-only owner-scoped read model; selection is local UI state, never authority. */
export class AgentsStore {
  readonly #listeners = new Set<() => void>();
  #snapshot = empty(null, null);
  #generation = 0;
  #refresh: Promise<void> | null = null;
  constructor(readonly api: AgentsDesktopApi) {}
  current = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #set(value: AgentsSnapshot) {
    this.#snapshot = value;
    for (const listener of this.#listeners) listener();
  }
  setOwner(ownerId: string | null, profileKey: string | null) {
    if (
      ownerId === this.#snapshot.ownerId &&
      profileKey === this.#snapshot.profileKey
    )
      return;
    this.#generation++;
    this.#refresh = null;
    this.#set(empty(ownerId, profileKey));
    if (ownerId) void this.refresh();
  }
  refresh = (): Promise<void> => {
    const ownerId = this.#snapshot.ownerId;
    if (!ownerId) return Promise.resolve();
    if (this.#refresh) return this.#refresh;
    const generation = this.#generation;
    this.#set({ ...this.#snapshot, loading: true, error: null });
    const task = (async () => {
      try {
        let agents = await this.api.list();
        if (generation !== this.#generation) return;
        const validate = (items: readonly Agent[]) => {
          if (
            items.some((item) => item.ownerUserId !== ownerId) ||
            new Set(items.map((item) => item.id)).size !== items.length ||
            items.filter((item) => item.isChiefOfStaff).length > 1
          )
            throw new Error("Invalid owner Agent list.");
        };
        validate(agents);
        if (!agents.some((agent) => agent.isChiefOfStaff)) {
          try {
            const chief = await this.api.ensureChief();
            if (generation !== this.#generation) return;
            if (!chief.isChiefOfStaff)
              throw new Error("Invalid Chief of Staff response.");
            const withChief = [chief, ...agents];
            validate(withChief);
            agents = withChief;
          } catch (error) {
            if (generation !== this.#generation) return;
            this.#set({
              ...this.#snapshot,
              agents,
              loading: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Chief of Staff is unavailable."
            });
            return;
          }
        }
        if (this.api.ensureHelpers) {
          try {
            const ensured = await this.api.ensureHelpers();
            if (generation !== this.#generation) return;
            validate(ensured);
            if (!ensured.some((agent) => agent.isChiefOfStaff))
              throw new Error(
                "Chief of Staff is unavailable after Helper setup."
              );
            agents = ensured;
          } catch (error) {
            if (generation !== this.#generation) return;
            this.#set({
              ...this.#snapshot,
              agents,
              loading: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Helper Agents are unavailable."
            });
            return;
          }
        }
        this.#set({
          ...this.#snapshot,
          agents,
          loading: false,
          selectedAgentId: agents.some(
            (agent) => agent.id === this.#snapshot.selectedAgentId
          )
            ? this.#snapshot.selectedAgentId
            : (agents.find((agent) => agent.isChiefOfStaff)?.id ?? null)
        });
      } catch (error) {
        if (generation !== this.#generation) return;
        this.#set({
          ...this.#snapshot,
          loading: false,
          error:
            error instanceof Error ? error.message : "Agents are unavailable."
        });
      }
    })();
    this.#refresh = task;
    void task.finally(() => {
      if (this.#refresh === task) this.#refresh = null;
    });
    return task;
  };
  choose(id: string) {
    if (!this.#snapshot.agents.some((agent) => agent.id === id))
      throw new Error("Agent is unavailable for this User.");
    this.#set({ ...this.#snapshot, selectedAgentId: id });
  }
}

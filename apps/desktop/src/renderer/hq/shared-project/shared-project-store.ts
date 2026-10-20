import type {
  WorkspaceProjectState,
  WorkspaceProjectWorkItem,
  WorkspaceProjectWorkItemCreate,
  WorkspaceProjectWorkItemPatch
} from "@koed/shared";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";

export type SharedProjectIdentity = {
  ownerId: string;
  profileKey: string;
  personalProjectId: string;
  workspaceProjectId: string;
  teamBackendId: string;
};

export type SharedProjectState = WorkspaceProjectState;

type WriteResult =
  | { status: "ok"; item: WorkspaceProjectWorkItem }
  | { status: "conflict"; state: SharedProjectState };

export type SharedProjectApi = {
  sharedRefresh?(
    workspaceProjectId: string,
    teamBackendId: string
  ): Promise<SharedProjectState>;
  sharedPatchWorkItem?(
    workspaceProjectId: string,
    teamBackendId: string,
    itemId: string,
    patch: WorkspaceProjectWorkItemPatch
  ): Promise<WriteResult>;
  sharedCreateWorkItem?(
    workspaceProjectId: string,
    teamBackendId: string,
    value: WorkspaceProjectWorkItemCreate
  ): Promise<WriteResult>;
  sharedSourcePick?(
    workspaceProjectId: string,
    teamBackendId: string,
    personalProjectId: string
  ): Promise<
    | { canceled: true; source: null }
    | {
        canceled: false;
        source: WorkspaceProjectState["sources"][number];
      }
  >;
  sharedReadSource?(
    workspaceProjectId: string,
    teamBackendId: string,
    personalProjectId: string,
    sourceId: string
  ): ReturnType<NonNullable<ProjectsDesktopApi["sharedReadSource"]>>;
  sharedPatchSource?: NonNullable<ProjectsDesktopApi["sharedPatchSource"]>;
  sharedDispatchWorkItem?(
    personalProjectId: string,
    itemId: string,
    agentId: string,
    expectedProjectVersion: number,
    expectedMemberVersion: number,
    expectedWorkItemVersion: number
  ): ReturnType<NonNullable<ProjectsDesktopApi["sharedDispatchWorkItem"]>>;
  sharedDispatches?: NonNullable<ProjectsDesktopApi["sharedDispatches"]>;
};

export type SharedDispatchBinding = {
  teamWorkItemId: string;
  executionId: string;
  agentId: string;
};

export type SharedProjectSnapshot = {
  identity: SharedProjectIdentity | null;
  state: SharedProjectState | null;
  dispatches: SharedDispatchBinding[];
  loading: boolean;
  pendingItemId: string | null;
  conflictItemId: string | null;
  error: string | null;
};

const empty = (): SharedProjectSnapshot => ({
  identity: null,
  state: null,
  dispatches: [],
  loading: false,
  pendingItemId: null,
  conflictItemId: null,
  error: null
});

const identityKey = (identity: SharedProjectIdentity | null) =>
  identity
    ? [
        identity.ownerId,
        identity.profileKey,
        identity.personalProjectId,
        identity.workspaceProjectId,
        identity.teamBackendId
      ].join("\u0000")
    : null;

export class SharedProjectStore {
  readonly #api: SharedProjectApi;
  readonly #listeners = new Set<() => void>();
  #snapshot = empty();
  #generation = 0;
  #request = 0;

  constructor(api: SharedProjectApi) {
    this.#api = api;
  }

  current = (): SharedProjectSnapshot => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(next: SharedProjectSnapshot) {
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }

  setIdentity(identity: SharedProjectIdentity | null) {
    if (identityKey(this.#snapshot.identity) === identityKey(identity)) return;
    this.#generation++;
    this.#request++;
    this.#set({ ...empty(), identity });
    if (identity) void this.refresh();
  }

  async refresh() {
    const identity = this.#snapshot.identity;
    if (!identity) return;
    if (this.#snapshot.pendingItemId) return;
    if (!this.#api.sharedRefresh) {
      this.#set({
        ...this.#snapshot,
        error: "Shared Project service is unavailable."
      });
      return;
    }
    const generation = this.#generation;
    const request = ++this.#request;
    this.#set({ ...this.#snapshot, loading: true });
    try {
      const state = await this.#api.sharedRefresh(
        identity.workspaceProjectId,
        identity.teamBackendId
      );
      const dispatches = this.#api.sharedDispatches
        ? await this.#api
            .sharedDispatches(identity.personalProjectId)
            .catch(() => [])
        : [];
      if (generation !== this.#generation || request !== this.#request) return;
      if (state.project && state.project.id !== identity.workspaceProjectId)
        throw new Error("Shared Project identity changed.");
      this.#set({
        ...this.#snapshot,
        state,
        dispatches: dispatches.filter((binding) =>
          state.workItems.some((item) => item.id === binding.teamWorkItemId)
        ),
        loading: false,
        error: null
      });
    } catch (error) {
      if (generation !== this.#generation || request !== this.#request) return;
      const statusCode =
        error && typeof error === "object" && "statusCode" in error
          ? Number(error.statusCode)
          : null;
      const denied =
        statusCode === 401 || statusCode === 403 || statusCode === 404;
      this.#set({
        ...this.#snapshot,
        loading: false,
        dispatches: [],
        state: denied
          ? null
          : this.#snapshot.state
            ? {
                ...this.#snapshot.state,
                readOnly: true,
                notice: "Offline. Shared changes are paused."
              }
            : null,
        error: denied
          ? "You no longer have access to this shared Project."
          : "Shared Project could not be refreshed."
      });
    }
  }

  async patchWorkItem(itemId: string, patch: WorkspaceProjectWorkItemPatch) {
    const identity = this.#snapshot.identity;
    if (
      !identity ||
      !this.#api.sharedPatchWorkItem ||
      !this.#snapshot.state ||
      this.#snapshot.state.readOnly ||
      this.#snapshot.pendingItemId
    )
      return false;
    const generation = this.#generation;
    const request = ++this.#request;
    this.#set({
      ...this.#snapshot,
      pendingItemId: itemId,
      conflictItemId: null,
      error: null
    });
    try {
      const result = await this.#api.sharedPatchWorkItem(
        identity.workspaceProjectId,
        identity.teamBackendId,
        itemId,
        patch
      );
      if (generation !== this.#generation || request !== this.#request)
        return false;
      if (result.status === "conflict") {
        this.#set({
          ...this.#snapshot,
          state: result.state,
          pendingItemId: null,
          conflictItemId: itemId,
          error:
            "This Work Item changed. Your edit is kept; review the latest version before saving again."
        });
        return false;
      }
      this.#set({
        ...this.#snapshot,
        state: {
          ...this.#snapshot.state!,
          workItems: this.#snapshot.state!.workItems.map((item) =>
            item.id === result.item.id ? result.item : item
          )
        },
        pendingItemId: null,
        error: null
      });
      return true;
    } catch {
      if (generation !== this.#generation || request !== this.#request)
        return false;
      this.#set({
        ...this.#snapshot,
        pendingItemId: null,
        error: null
      });
      await this.refresh();
      if (generation === this.#generation)
        this.#set({
          ...this.#snapshot,
          error: "Shared change could not be saved."
        });
      return false;
    }
  }

  async createWorkItem(value: WorkspaceProjectWorkItemCreate) {
    const identity = this.#snapshot.identity;
    if (
      !identity ||
      !this.#api.sharedCreateWorkItem ||
      !this.#snapshot.state ||
      this.#snapshot.state.readOnly ||
      this.#snapshot.pendingItemId
    )
      return false;
    const generation = this.#generation;
    const request = ++this.#request;
    this.#set({ ...this.#snapshot, pendingItemId: "new", error: null });
    try {
      const result = await this.#api.sharedCreateWorkItem(
        identity.workspaceProjectId,
        identity.teamBackendId,
        value
      );
      if (generation !== this.#generation || request !== this.#request)
        return false;
      if (result.status === "conflict") {
        this.#set({
          ...this.#snapshot,
          state: result.state,
          pendingItemId: null,
          error: "Shared work changed. Your new to-do text is kept."
        });
        return false;
      }
      this.#set({
        ...this.#snapshot,
        state: {
          ...this.#snapshot.state!,
          workItems: [...this.#snapshot.state!.workItems, result.item]
        },
        pendingItemId: null,
        error: null
      });
      return true;
    } catch {
      if (generation !== this.#generation || request !== this.#request)
        return false;
      this.#set({
        ...this.#snapshot,
        pendingItemId: null,
        error: "Shared to-do could not be added. Your text is kept."
      });
      return false;
    }
  }
  async pickSource() {
    const identity = this.#snapshot.identity;
    if (
      !identity ||
      !this.#api.sharedSourcePick ||
      !this.#snapshot.state ||
      this.#snapshot.state.readOnly
    )
      return null;
    const generation = this.#generation;
    try {
      const picked = await this.#api.sharedSourcePick(
        identity.workspaceProjectId,
        identity.teamBackendId,
        identity.personalProjectId
      );
      if (generation !== this.#generation || picked.canceled) return null;
      await this.refresh();
      return picked.source;
    } catch {
      if (generation === this.#generation)
        this.#set({
          ...this.#snapshot,
          error: "Shared Source could not be added."
        });
      return null;
    }
  }
  async readSource(sourceId: string) {
    const identity = this.#snapshot.identity;
    if (!identity || !this.#api.sharedReadSource) return null;
    const generation = this.#generation;
    try {
      const content = await this.#api.sharedReadSource(
        identity.workspaceProjectId,
        identity.teamBackendId,
        identity.personalProjectId,
        sourceId
      );
      return generation === this.#generation ? content : null;
    } catch {
      return null;
    }
  }
  async patchSource(
    sourceId: string,
    expectedVersion: number,
    patch: { name?: string; deleted?: boolean }
  ) {
    const identity = this.#snapshot.identity;
    if (
      !identity ||
      !this.#api.sharedPatchSource ||
      !this.#snapshot.state ||
      this.#snapshot.state.readOnly
    )
      return null;
    const generation = this.#generation;
    try {
      const source = await this.#api.sharedPatchSource(
        identity.workspaceProjectId,
        identity.teamBackendId,
        sourceId,
        { expectedVersion, ...patch }
      );
      if (generation !== this.#generation) return null;
      await this.refresh();
      return source;
    } catch {
      if (generation === this.#generation)
        this.#set({
          ...this.#snapshot,
          error: "Shared Source changed or you cannot edit its metadata."
        });
      return null;
    }
  }
  async dispatchWorkItem(item: WorkspaceProjectWorkItem, agentId: string) {
    const identity = this.#snapshot.identity;
    const state = this.#snapshot.state;
    if (
      !identity ||
      !state ||
      state.readOnly ||
      !state.project ||
      !state.memberVersion ||
      !this.#api.sharedDispatchWorkItem ||
      this.#snapshot.pendingItemId
    )
      return false;
    const generation = this.#generation;
    this.#set({ ...this.#snapshot, pendingItemId: item.id, error: null });
    try {
      await this.#api.sharedDispatchWorkItem(
        identity.personalProjectId,
        item.id,
        agentId,
        state.project.version,
        state.memberVersion,
        item.version
      );
      if (generation !== this.#generation) return false;
      this.#set({ ...this.#snapshot, pendingItemId: null });
      await this.refresh();
      return true;
    } catch {
      if (generation !== this.#generation) return false;
      this.#set({
        ...this.#snapshot,
        pendingItemId: null,
        error: "Could not send this shared to-do. Review the latest Team state."
      });
      await this.refresh();
      return false;
    }
  }
}

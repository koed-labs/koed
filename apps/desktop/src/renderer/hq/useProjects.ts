import type { Project } from "@koed/shared";
import type { ProjectsDesktopApi } from "../../ipc/projects-protocol.js";

export type ProjectsSnapshot = {
  ownerId: string | null;
  profileKey: string | null;
  projects: readonly Project[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
};

const empty = (
  ownerId: string | null,
  profileKey: string | null
): ProjectsSnapshot => ({
  ownerId,
  profileKey,
  projects: [],
  loading: false,
  loaded: false,
  error: null
});

export class ProjectsStore {
  readonly #api: ProjectsDesktopApi;
  readonly #listeners = new Set<() => void>();
  #snapshot = empty(null, null);
  #versions = new Map<string, number>();
  #generation = 0;
  #refresh: Promise<void> | null = null;
  #refreshAgain = false;

  constructor(api: ProjectsDesktopApi) {
    this.#api = api;
  }
  current = (): ProjectsSnapshot => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #set(snapshot: ProjectsSnapshot) {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
  setOwner(ownerId: string | null, profileKey: string | null): void {
    if (
      this.#snapshot.ownerId === ownerId &&
      this.#snapshot.profileKey === profileKey
    )
      return;
    this.#generation++;
    this.#versions.clear();
    this.#refresh = null;
    this.#refreshAgain = false;
    this.#set(empty(ownerId, profileKey));
    if (ownerId) void this.refresh();
  }
  refresh = async (): Promise<void> => {
    const ownerId = this.#snapshot.ownerId;
    if (!ownerId) return;
    if (this.#refresh) {
      this.#refreshAgain = true;
      return this.#refresh;
    }
    const generation = this.#generation;
    this.#set({ ...this.#snapshot, loading: true, error: null });
    const request = (async () => {
      try {
        const projects = await this.#api.list();
        if (generation !== this.#generation) return;
        if (this.#refreshAgain) return;
        const previousById = new Map(
          this.#snapshot.projects.map((project) => [project.id, project])
        );
        const visible = projects.flatMap((project) => {
          const known = this.#versions.get(project.id);
          if (known !== undefined && project.version < known) {
            const previous = previousById.get(project.id);
            return previous && previous.version === known ? [previous] : [];
          }
          if (known === project.version && !previousById.has(project.id))
            return [];
          this.#versions.set(project.id, project.version);
          return [project];
        });
        this.#set({
          ownerId,
          profileKey: this.#snapshot.profileKey,
          projects: visible,
          loading: false,
          loaded: true,
          error: null
        });
      } catch (error) {
        if (generation !== this.#generation) return;
        this.#set({
          ...this.#snapshot,
          loading: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })();
    this.#refresh = request;
    await request;
    if (generation !== this.#generation) return;
    this.#refresh = null;
    if (this.#refreshAgain) {
      this.#refreshAgain = false;
      await this.refresh();
    }
  };
  projectChanged(
    ownerId: string,
    profileKey: string,
    projectId: string,
    project: Project | null
  ): void {
    if (
      this.#snapshot.ownerId !== ownerId ||
      this.#snapshot.profileKey !== profileKey
    )
      return;
    if (!this.#snapshot.loaded) {
      void this.refresh();
      return;
    }
    if (this.#refresh) this.#refreshAgain = true;
    if (!project || project.id !== projectId) {
      void this.refresh();
      return;
    }
    const version = this.#versions.get(projectId);
    if (version !== undefined && project.version <= version) return;
    this.#versions.set(projectId, project.version);
    const projects = this.#snapshot.projects.filter(
      ({ id }) => id !== projectId
    );
    if (project.lifecycle === "active") projects.push(project);
    this.#set({ ...this.#snapshot, projects });
  }
}

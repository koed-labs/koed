import { randomUUID } from "node:crypto";
import {
  discoverProjectMetadata,
  listProjectMetadata,
  setProjectAssociationLookup,
  type KoedServerPaths
} from "@koed-labs/server";
import { isPortableGitRemote } from "@koed/shared";
import {
  projectSelectionCommandSchema,
  projectSelectionCommandResultSchema,
  projectSelectionLookupResponseSchema,
  type ProjectSelectionCommandResult
} from "@koed/shared/project-selection";

export const createProjectSelectionLookup =
  (request: (path: string) => Promise<Record<string, unknown>>) =>
  async (
    _paths: KoedServerPaths,
    checkout: { originatingDeviceId: string; checkoutId: string }
  ) => {
    const result = projectSelectionLookupResponseSchema.parse(
      await request(
        `/v1/memory/repository-selection?${new URLSearchParams(checkout)}`
      )
    );
    return result.association?.selection
      ? {
          associationId: result.association.associationId,
          selection: result.association.selection
        }
      : undefined;
  };

export const createProjectSelectionCommand =
  (deps: {
    paths: KoedServerPaths;
    request(path: string, init?: RequestInit): Promise<Record<string, unknown>>;
    status(): Promise<Record<string, unknown>>;
    discover?: typeof discoverProjectMetadata;
    setLookup?: typeof setProjectAssociationLookup;
    list?: typeof listProjectMetadata;
    randomId?: () => string;
  }) =>
  async (args: unknown): Promise<ProjectSelectionCommandResult> => {
    const input = projectSelectionCommandSchema.parse(args);
    const local = (
      (deps.list ?? listProjectMetadata)(deps.paths).projects ?? []
    ).find((entry) => entry.localProjectId === input.localProjectId);
    if (!local)
      throw new Error("Local Project is unavailable; inspect it again");
    const discoveryDeps = {
      lookupAssociatedSelection: createProjectSelectionLookup(deps.request)
    };
    const discover: typeof discoverProjectMetadata =
      deps.discover ??
      ((paths, input) => discoverProjectMetadata(paths, input, discoveryDeps));
    const cwd = local.path.projectRoot ?? local.path.cwd;
    const project = (await discover(deps.paths, { cwd })).project;
    const repository = project?.repository;
    if (!repository?.checkoutId)
      throw new Error("Checkout provenance is unavailable");
    if (
      input.operation !== "inspect" &&
      repository.checkoutId !== input.expectedCheckoutId
    )
      throw new Error("Checkout changed; inspect the Project again");
    const identity = {
      originatingDeviceId: repository.originatingDeviceId,
      checkoutId: repository.checkoutId
    };
    const query = new URLSearchParams(identity).toString();
    const observed = (
      await deps.request(`/v1/memory/repository-selection?${query}`)
    ).association as {
      groupId: string;
      associationId: string;
      selectionId: string;
    } | null;
    const current = observed
      ? projectSelectionCommandResultSchema.shape.accepted.parse({
          groupId: observed.groupId,
          associationId: observed.associationId,
          selectionId: observed.selectionId
        })
      : null;
    const status = await deps.status();
    const groups = Array.isArray(status.groups)
      ? status.groups.filter(
          (value): value is { group_id: string; state: string } =>
            typeof value === "object" &&
            value !== null &&
            typeof (value as { group_id?: unknown }).group_id === "string" &&
            (value as { state?: unknown }).state === "active"
        )
      : [];
    if (groups.length > 1)
      throw new Error("Personal Device Group selection is ambiguous");
    const groupId = groups[0]?.group_id ?? null;
    const deviceLabels: Record<string, string> = {};
    const members = (groups[0] as { members?: unknown } | undefined)?.members;
    if (Array.isArray(members))
      for (const member of members) {
        if (
          member &&
          typeof member === "object" &&
          typeof member.device_id === "string" &&
          typeof member.label === "string" &&
          member.label.trim()
        )
          deviceLabels[member.device_id] = member.label.slice(0, 80);
      }
    const request = (path: string, body: unknown, method = "POST") =>
      deps.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    const setLookup: typeof setProjectAssociationLookup =
      deps.setLookup ??
      ((paths, input) =>
        setProjectAssociationLookup(paths, input, discoveryDeps));
    const marker = {
      localProjectId: input.localProjectId,
      expectedCheckoutId: repository.checkoutId
    };
    const fingerprint = (remoteName: string): string => {
      const remotes =
        project?.git?.remotes.filter((remote) => remote.name === remoteName) ??
        [];
      if (
        !remotes.length ||
        remotes.some((remote) => !isPortableGitRemote(remote)) ||
        new Set(remotes.map((remote) => remote.fingerprint)).size !== 1
      )
        throw new Error("Choose a current portable repository remote");
      return remotes[0]!.fingerprint;
    };
    if (input.operation === "create") {
      if (!groupId)
        throw new Error(
          "Pair Personal devices before sharing a Project selection"
        );
      const association = {
        groupId,
        associationId: (deps.randomId ?? randomUUID)(),
        selectionId: (deps.randomId ?? randomUUID)()
      };
      await request("/v1/pds/project-selections", {
        ...association,
        reviewedHeads: [],
        operation: {
          kind: "set",
          anchorFingerprint: fingerprint(input.remoteName)
        }
      });
      await setLookup(deps.paths, { ...marker, enabled: true });
      await request("/v1/pds/project-associations/accept", {
        ...association,
        ...identity,
        localProjectId: input.localProjectId
      });
    } else if (input.operation === "accept") {
      if (!groupId || input.groupId !== groupId)
        throw new Error(
          "Personal Device Group changed; inspect the association again"
        );
      await setLookup(deps.paths, { ...marker, enabled: true });
      await request("/v1/pds/project-associations/accept", {
        groupId,
        associationId: input.associationId,
        selectionId: input.selectionId,
        ...identity,
        localProjectId: input.localProjectId
      });
    } else if (input.operation === "forget") {
      await request("/v1/pds/project-associations/accept", identity, "DELETE");
      await setLookup(deps.paths, { ...marker, enabled: false });
    } else if (input.operation === "set") {
      if (
        !current ||
        current.groupId !== groupId ||
        input.groupId !== groupId ||
        current.associationId !== input.associationId ||
        current.selectionId !== input.selectionId
      )
        throw new Error(
          "Accept this Project association before changing its shared selection"
        );
      await request("/v1/pds/project-selections", {
        ...current,
        reviewedHeads: input.reviewedHeads,
        operation:
          input.remoteName === null
            ? { kind: "delete" }
            : { kind: "set", anchorFingerprint: fingerprint(input.remoteName) }
      });
    }
    if (input.operation !== "inspect") await discover(deps.paths, { cwd });
    const accepted = (
      await deps.request(`/v1/memory/repository-selection?${query}`)
    ).association;
    const associations = groupId
      ? (
          await deps.request(
            `/v1/pds/project-associations?groupId=${encodeURIComponent(groupId)}`
          )
        ).associations
      : [];
    const parsedAccepted =
      accepted && typeof accepted === "object"
        ? {
            groupId: (accepted as Record<string, unknown>).groupId,
            associationId: (accepted as Record<string, unknown>).associationId,
            selectionId: (accepted as Record<string, unknown>).selectionId
          }
        : null;
    return projectSelectionCommandResultSchema.parse({
      checkoutId: repository.checkoutId,
      defaultRemote: repository.selectedRemote,
      deviceLabels,
      remotes: (project?.git?.remotes ?? [])
        .filter(isPortableGitRemote)
        .map((remote) => ({
          name: remote.name,
          fingerprint: remote.fingerprint,
          display: remote.display
        })),
      groupId,
      accepted: parsedAccepted,
      associations
    });
  };

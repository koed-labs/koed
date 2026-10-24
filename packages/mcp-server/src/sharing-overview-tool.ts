import type { McpServer } from "@modelcontextprotocol/server";
import {
  sharingOverviewSchema,
  sharingAgentOverviewSchema,
  type SharingOverview,
  readDesktopLocalCredentialAuthorization
} from "@koed/shared";
import { z } from "zod";
import { managedRecallSelector } from "./managed-project-recall-context.js";

export const sharingOverviewInput = z
  .object({
    person: z.string().trim().min(1).max(160).optional(),
    projectId: z.uuid().optional(),
    backendId: z.string().trim().min(1).max(160).optional()
  })
  .strict();

export const filterSharingOverview = (
  overview: SharingOverview,
  input: z.infer<typeof sharingOverviewInput>
): SharingOverview => {
  if (!input.person && !input.projectId && !input.backendId) return overview;
  const person = input.person?.toLocaleLowerCase();
  const matchesPerson = (name: string) =>
    !person || name.toLocaleLowerCase().includes(person);
  return sharingOverviewSchema.parse({
    backends: overview.backends.map((backend) => {
      if (backend.status === "unavailable") return backend;
      if (input.backendId && backend.backendId !== input.backendId)
        return {
          ...backend,
          data: {
            ...backend.data,
            projects: [],
            invitations: [],
            workspaceAccess: []
          },
          incomingInvitations: []
        };
      const projects = backend.data.projects
        .filter(
          (project) =>
            (!input.projectId || project.id === input.projectId) &&
            (!person ||
              matchesPerson(project.owner.displayName) ||
              project.members.some((member) =>
                matchesPerson(member.person.displayName)
              ) ||
              project.invitations.some((invite) =>
                matchesPerson(invite.person.displayName)
              ))
        )
        .map((project) => ({
          ...project,
          members: project.members.filter((member) =>
            matchesPerson(member.person.displayName)
          ),
          invitations: project.invitations.filter((invite) =>
            matchesPerson(invite.person.displayName)
          )
        }));
      return {
        ...backend,
        data: {
          ...backend.data,
          projects,
          invitations: backend.data.invitations.filter(
            (invite) =>
              !input.projectId && matchesPerson(invite.person.displayName)
          ),
          workspaceAccess: backend.data.workspaceAccess.filter(
            (access) =>
              !input.projectId && matchesPerson(access.person.displayName)
          )
        },
        incomingInvitations: backend.incomingInvitations.filter(
          (invite) =>
            !input.projectId && matchesPerson(invite.inviter.displayName ?? "")
        )
      };
    })
  });
};

export const readManagedSharingOverview = async (
  input: z.infer<typeof sharingOverviewInput>,
  environment: NodeJS.ProcessEnv = process.env,
  send: typeof fetch = fetch
) => {
  const query = sharingOverviewInput.parse(input);
  const selector = managedRecallSelector(environment);
  if (!selector)
    throw new Error(
      "Sharing overview requires a current local managed Conversation"
    );
  const credential = readDesktopLocalCredentialAuthorization(selector.koedHome);
  if (
    !credential?.operationFamilies.includes("personal_collaboration_read") ||
    !credential.operationFamilies.includes("managed_execution")
  )
    throw new Error("Sharing overview lacks current owner authority");
  const url = new URL(
    `/v1/managed-conversations/${selector.executionId}/sharing-overview`,
    selector.apiUrl
  );
  url.searchParams.set("executionGeneration", String(selector.generation));
  const response = await send(url, {
    method: "GET",
    redirect: "error",
    headers: {
      authorization: credential.authorization,
      accept: "application/json"
    },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok)
    throw new Error(`Sharing overview unavailable (${response.status})`);
  const raw = await response.text();
  if (raw.length > 2_000_000)
    throw new Error("Sharing overview exceeded its limit");
  const result = sharingAgentOverviewSchema.parse(JSON.parse(raw));
  const overview = filterSharingOverview(result.overview, query);
  const projectTeams = new Set(
    overview.backends.flatMap((backend) =>
      backend.status === "available"
        ? backend.data.projects.map(
            (project) => `${backend.backendId}:${project.teamId}`
          )
        : []
    )
  );
  const person = query.person?.toLocaleLowerCase();
  return sharingAgentOverviewSchema.parse({
    ...result,
    overview,
    teams: result.teams.map((backend) => {
      if (backend.status === "unavailable") return backend;
      return {
        ...backend,
        teams: backend.teams
          .filter(
            (team) =>
              (!query.backendId || query.backendId === backend.backendId) &&
              (!query.projectId ||
                projectTeams.has(`${backend.backendId}:${team.teamId}`))
          )
          .map((team) => ({
            ...team,
            people: team.people.filter(
              (item) =>
                !person || item.name.toLocaleLowerCase().includes(person)
            )
          }))
      };
    })
  });
};

export const registerSharingOverviewTool = (
  server: McpServer,
  environment: NodeJS.ProcessEnv = process.env
): void => {
  if (
    !managedRecallSelector(environment) ||
    environment.KOED_MANAGED_TEXT_ACTIONS !== "1"
  )
    return;
  server.registerTool(
    "sharing_overview",
    {
      title: "Sharing overview",
      description:
        "Read the current User's Sharing page data, optionally narrowed to one person or Project. Every unavailable Team backend remains explicit; do not treat it as empty. This tool changes nothing.",
      inputSchema: sharingOverviewInput,
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    async (input) => {
      try {
        const overview = await readManagedSharingOverview(input, environment);
        return {
          structuredContent: overview,
          content: [{ type: "text" as const, text: JSON.stringify(overview) }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                error instanceof Error
                  ? error.message
                  : "Sharing overview unavailable"
            }
          ]
        };
      }
    }
  );
};

// Installed Pi resources load this managed helper from the runtime package.
export { sharingHelpInstructions } from "@koed/shared";

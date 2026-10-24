import type { McpServer } from "@modelcontextprotocol/server";
import {
  koedTextActionInputSchemas,
  koedTextActionNames,
  koedTextActionReceipt,
  type KoedTextActionName
} from "@koed/shared";

const descriptions: Record<KoedTextActionName, string> = {
  koed_project_create:
    "Request a new Personal Project. Koed applies the User's current Project creation permission and exact review policy.",
  koed_project_move_chats:
    "Request to move the User's selected Conversations into a Project. Koed checks each current owner and sharing effect before review.",
  koed_project_delete:
    "Request deletion of the User's Project. Koed uses its separate Native deletion review and lifecycle coordinator.",
  koed_project_leave:
    "Request a human review to leave a currently linked shared Project. A Project owner is shown a separate explicit delete proposal; no Team access changes from this tool call.",
  koed_workspace_leave:
    "Request a human review to leave the current shared group. Koed shows owned Project effects and requires exact confirmation; this tool call changes no Team access.",
  koed_chat_create:
    "Open a new chat composer, optionally with a Project selected. The User's first message creates the Conversation.",
  koed_chat_move:
    "Request to move one of the User's Conversations. Koed checks the sharing boundary and requests Native review where required.",
  koed_chat_delete:
    "Request deletion of the User's Conversation. Koed uses its separate Native deletion review and Undo lifecycle.",
  koed_todo_add:
    "Request a Work Item in the User's Project, with an optional calendar due date. Koed verifies the Project and records the exact result.",
  koed_todo_send:
    "Request to send an owned Work Item to an Agent. Koed verifies the item, Agent, Project and current runtime authority.",
  koed_team_invite:
    "Request an email invitation to one owned shared Project. Koed verifies the current Team and Project and opens exact Native invitation review before issuing it.",
  sharing_remove:
    "Request removal of exact backend-qualified Project members, Workspace Access or Team members, or cancellation of invitations. For 'everything with a person', include every current manageable target from sharing_overview; report unavailable backends and never claim they are empty. Koed uses each existing Step-up or Native review, sequentially, with five-second Undo. This call changes no access.",
  koed_job_create:
    "Request a Scheduled Job in this human-started Conversation. Give an exact title, instruction, calendar schedule, and IANA time zone. Koed verifies the owner, Agent, Conversation and Project before review.",
  koed_job_pause:
    "Request pause or resume of one owned Scheduled Job by its exact unique title. Koed rejects missing or ambiguous titles and verifies current lifecycle authority.",
  koed_deck_make:
    "Make flashcards for the current Project. Read authorized Project Sources and scoped memory in this AI Client first. Supply the exact requested scope, title, source description and generated question/answer cards. Respect exclusions such as material not on the exam. Optional card sourceRef is only a display label, never access authority. Koed reviews the exact content and creates the Deck idempotently.",
  koed_hq_open:
    "Request to open the named Project HQ in the User's Desktop. This only requests navigation.",
  koed_sharing_open:
    "Request to open the User's Sharing page in Koed Desktop. This only requests navigation.",
  koed_settings_open:
    "Request to open Koed settings in the User's Desktop. This only requests navigation.",
  koed_settings_set_theme:
    "Request a User-facing theme change in the current Desktop."
};

/** Tool completion is a proposal receipt, never a Project or Desktop credential. */
export const registerKoedTextActionTools = (server: McpServer): void => {
  for (const name of koedTextActionNames) {
    server.registerTool(
      name,
      {
        title: name.replace(/^koed_/, "").replaceAll("_", " "),
        description: descriptions[name],
        inputSchema: koedTextActionInputSchemas[name],
        annotations: { readOnlyHint: false }
      },
      () =>
        Promise.resolve({
          structuredContent: { status: "requested" },
          content: [
            { type: "text" as const, text: koedTextActionReceipt(name) }
          ]
        })
    );
  }
};

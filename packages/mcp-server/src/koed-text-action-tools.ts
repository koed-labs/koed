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
  koed_job_create:
    "Request a Scheduled Job in this human-started Conversation. Give an exact title, instruction, calendar schedule, and IANA time zone. Koed verifies the owner, Agent, Conversation and Project before review.",
  koed_job_pause:
    "Request pause or resume of one owned Scheduled Job by its exact unique title. Koed rejects missing or ambiguous titles and verifies current lifecycle authority.",
  koed_hq_open:
    "Request to open the named Project HQ in the User's Desktop. This only requests navigation.",
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

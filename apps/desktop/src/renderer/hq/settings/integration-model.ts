import type { ComponentStatus, KoedServerStatus } from "../../../types.js";
export type IntegrationMutationCommand =
  | "setup_codex"
  | "repair_codex"
  | "remove_codex"
  | "setup_pi"
  | "repair_pi"
  | "remove_pi"
  | "setup_claude"
  | "repair_claude"
  | "remove_claude";

export const integrationConsentCopy: Record<
  IntegrationMutationCommand,
  { title: string; description: string; confirmLabel: string }
> = {
  setup_codex: {
    title: "Set up the Codex integration?",
    description:
      "Koed will add its marked Codex integration block and Supported Capture Hook. Unrelated settings, credentials, and other clients remain untouched.",
    confirmLabel: "Set up Codex"
  },
  repair_codex: {
    title: "Repair the Codex integration?",
    description:
      "Koed will replace only its marked Codex integration block and Supported Capture Hook. Unrelated settings and credentials remain untouched.",
    confirmLabel: "Repair Codex"
  },
  remove_codex: {
    title: "Remove the Codex integration?",
    description:
      "Koed will remove only its marked Codex integration block. Unrelated settings and credentials remain untouched.",
    confirmLabel: "Remove Codex"
  },
  setup_pi: {
    title: "Set up the Pi integration?",
    description:
      "Koed will register its local package in your active global Pi profile, or remove only that Koed-owned package. It preserves unrelated Pi settings, packages, and provider credentials.",
    confirmLabel: "Set up Pi"
  },
  repair_pi: {
    title: "Repair the Pi integration?",
    description:
      "Koed will replace only its package in the active Pi profile. Unrelated packages, settings, and provider credentials remain untouched.",
    confirmLabel: "Repair Pi"
  },
  remove_pi: {
    title: "Remove the Pi integration?",
    description:
      "Koed will remove only its package from the active Pi profile and preserve unrelated packages, settings, and provider credentials.",
    confirmLabel: "Remove Pi"
  },
  setup_claude: {
    title: "Set up the Claude Code integration?",
    description:
      "Koed will add its MCP Server and Supported Capture Hook to Claude Code settings, or remove only those Koed-owned entries. It preserves unrelated settings, hooks, and provider credentials.",
    confirmLabel: "Set up Claude Code"
  },
  repair_claude: {
    title: "Repair the Claude Code integration?",
    description:
      "Koed will replace only its MCP Server and Supported Capture Hook entries in Claude Code. Unrelated settings, hooks, and provider credentials remain untouched.",
    confirmLabel: "Repair Claude Code"
  },
  remove_claude: {
    title: "Remove the Claude Code integration?",
    description:
      "Koed will remove only its owned MCP Server and Supported Capture Hook entries. Unrelated settings, hooks, and provider credentials remain untouched.",
    confirmLabel: "Remove Claude Code"
  }
};

export const preferenceClients: readonly {
  id: "codex" | "claude" | "pi";
  label: string;
}[] = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "pi", label: "Pi" }
];

export const flatClientStatus = (
  id: "codex" | "claude" | "pi",
  status: KoedServerStatus | null
): (ComponentStatus & { configured: boolean }) | undefined =>
  id === "codex"
    ? status?.codex
    : id === "claude"
      ? status?.claudeCode
      : status?.pi;

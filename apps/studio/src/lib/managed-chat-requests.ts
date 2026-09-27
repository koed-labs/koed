import { record, type RuntimeSnapshot } from "./managed-agent-chat";

export type PendingChatRequest = {
  id: string;
  kind:
    | "command_approval"
    | "file_approval"
    | "permissions_approval"
    | "user_input";
  description: string;
  details: { label: string; text: string }[];
  questions?: {
    id: string;
    header?: string;
    question: string;
    required?: boolean;
    isSecret?: boolean;
    isOther?: boolean;
    options?: { label: string }[];
  }[];
};

const kinds = new Set([
  "command_approval",
  "file_approval",
  "permissions_approval",
  "user_input"
]);
const bounded = (value: unknown): string =>
  typeof value === "string"
    ? value.length > 12000
      ? `${value.slice(0, 12000)}\n[Preview truncated]`
      : value
    : "";

export function pendingChatRequests(
  snapshot: RuntimeSnapshot | null
): PendingChatRequest[] {
  return (snapshot?.items ?? []).flatMap((item) => {
    const renderer = item.presentation?.renderer;
    if (
      !kinds.has(item.itemKind) ||
      item.answered ||
      item.state !== "pending" ||
      !item.presentation ||
      item.presentation.mode === "hidden" ||
      (item.itemKind === "user_input"
        ? renderer !== "user_input"
        : renderer !== "approval")
    )
      return [];
    const payload = item.payload;
    const details: PendingChatRequest["details"] = [];
    for (const [key, label] of [
      ["command", "Command"],
      ["cwd", "Working directory"],
      ["grantRoot", "Grant root"],
      ["diff", "Changes"],
      ["toolName", "Tool"]
    ]) {
      const value =
        key === "command" && Array.isArray(payload.command)
          ? payload.command.filter((part) => typeof part === "string").join(" ")
          : payload[key];
      const text = bounded(value);
      if (text) details.push({ label, text });
    }
    if (
      item.itemKind === "permissions_approval" &&
      record(payload.permissions)
    ) {
      details.push({
        label: "Permissions",
        text: bounded(JSON.stringify(payload.permissions, null, 2))
      });
    }
    if (typeof payload.toolName === "string" && record(payload.input)) {
      for (const key of [
        "command",
        "cmd",
        "file_path",
        "path",
        "patch",
        "diff"
      ]) {
        const text = bounded(payload.input[key]);
        if (text) details.push({ label: key, text });
      }
    }
    const questions = (
      Array.isArray(payload.questions) ? payload.questions : []
    ).flatMap((question) => {
      if (
        !record(question) ||
        typeof question.id !== "string" ||
        typeof question.question !== "string"
      )
        return [];
      return [
        {
          id: question.id,
          question: bounded(question.question),
          header: bounded(question.header),
          ...(typeof question.required === "boolean"
            ? { required: question.required }
            : {}),
          isSecret: question.isSecret === true,
          isOther: question.isOther === true,
          options: (Array.isArray(question.options)
            ? question.options
            : []
          ).flatMap((option) =>
            record(option) && typeof option.label === "string"
              ? [{ label: option.label }]
              : []
          )
        }
      ];
    });
    return [
      {
        id: item.id,
        kind: item.itemKind as PendingChatRequest["kind"],
        description:
          bounded(payload.reason) ||
          (item.itemKind === "user_input"
            ? "The agent needs your input"
            : "The agent needs your approval"),
        details,
        ...(item.itemKind === "user_input" ? { questions } : {})
      }
    ];
  });
}

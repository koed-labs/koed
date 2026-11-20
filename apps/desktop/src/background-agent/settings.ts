export function agentSettingsChoices(
  status: "enabled" | "disabled" | "requires-approval"
): string[] {
  if (status === "enabled") return ["Reconcile", "Disable", "Cancel"];
  if (status === "requires-approval") return ["Disable", "Cancel"];
  return ["Enable", "Cancel"];
}

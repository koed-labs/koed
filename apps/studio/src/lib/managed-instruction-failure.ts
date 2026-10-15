export const managedInstructionFailureMessage = (
  code: string | null | undefined
): string | null => {
  switch (code) {
    case "ManagedConversationProjectInstructionsReadError":
      return "Claude could not read the Project's root CLAUDE.md. Check that it is a regular UTF-8 file no larger than 64 KiB, then retry.";
    case "ManagedConversationProjectInstructionsSnapshotError":
      return "Claude's saved Project instructions could not be restored. Restore the original instruction snapshot before continuing; the current file has not replaced it.";
    case "ManagedConversationInstructionSkillsUnavailableError":
      return "Selected skills are not yet supported with isolated Claude Project instructions. Remove the skill selection and send again.";
    case "ManagedConversationProjectInstructionsTransferError":
      return "This Claude chat's saved Project instructions cannot yet be transferred to another runtime. The transfer has not completed.";
    default:
      return null;
  }
};

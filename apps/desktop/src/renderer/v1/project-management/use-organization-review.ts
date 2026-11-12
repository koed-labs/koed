import { useEffect, useState } from "react";
import type { PersonalConversationOrganizationInput } from "@koed-labs/shared";
import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import {
  reviewConversationOrganization,
  type OrganizationReview
} from "./conversation-organization.js";

export type ConversationManagementTarget = {
  sessionId: string;
  title: string;
  sourceProjectId?: string;
  deviceName?: string;
};
export type OrganizationDialogProps = {
  api: PersonalDesktopApi;
  projects: readonly DesktopProject[];
  target: ConversationManagementTarget;
  onClose: () => void;
  onApply: (
    edit: PersonalConversationOrganizationInput,
    preferredProjectId?: string
  ) => Promise<void>;
};
export const projectErrorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export function useOrganizationReview({
  api,
  projects,
  target,
  onApply
}: OrganizationDialogProps) {
  const [review, setReview] = useState<OrganizationReview>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Freeze the inventory the dialog reviews. A refresh never silently replaces
  // a draft or the versions the User saw.
  const [initialProjects] = useState(projects);
  useEffect(() => {
    let current = true;
    void reviewConversationOrganization(api, initialProjects, target.sessionId)
      .then((value) => {
        if (current) setReview(value);
      })
      .catch((cause) => {
        if (current) setError(projectErrorMessage(cause));
      });
    return () => {
      current = false;
    };
  }, [api, initialProjects, target.sessionId]);
  const apply = async (
    edit: PersonalConversationOrganizationInput,
    preferredProjectId?: string
  ) => {
    setBusy(true);
    setError("");
    try {
      await onApply(edit, preferredProjectId);
    } catch (cause) {
      setError(projectErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return { review, error, setError, busy, apply };
}

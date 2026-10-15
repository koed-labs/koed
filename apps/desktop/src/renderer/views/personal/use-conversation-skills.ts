import { useEffect, useState } from "react";
import type { AiClientResource } from "@koed/shared/ai-client-resource-catalog";
import type { NativeSkillPickerScope } from "@koed/ui";
import type { ManagedConversationSkillSelection } from "../../../ipc/managed-conversation-protocol.js";

/** Keep explicit choices with their actual Client/computer/Project, never the model name. */
export function useConversationSkills(scope: NativeSkillPickerScope) {
  const key = JSON.stringify(scope);
  const [state, setState] = useState<{
    key: string;
    skills: AiClientResource[];
    expiresAt: string;
  } | null>(null);
  // Discard an old scope rather than revive its choices on A -> B -> A navigation.
  if (state && state.key !== key) setState(null);
  const current = state?.key === key ? state : null;
  const skills = current?.skills ?? [];
  const [, refreshExpiry] = useState(0);
  const expiresAt = current?.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(
      () => refreshExpiry((value) => value + 1),
      Math.max(0, Date.parse(expiresAt) - Date.now()) + 1
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const selection: ManagedConversationSkillSelection = skills.length
    ? {
        selectedResourceIds: skills.map((skill) => skill.resourceId),
        selectedResourceHostedInstanceId:
          scope.hostedInstanceId ?? scope.instanceId
      }
    : {};
  return {
    skills,
    selection,
    get expired() {
      // Read the clock at submission too, even before the expiry timer renders.
      return skills.length > 0 && Date.parse(current!.expiresAt) <= Date.now();
    },
    select(skill: AiClientResource, expiresAt: string) {
      setState((previous) => {
        const singleSkill =
          scope.provider === "claude" || scope.provider === "claude-code";
        const selected =
          !singleSkill && previous?.key === key ? previous.skills : [];
        if (
          selected.length >= 8 ||
          selected.some((item) => item.resourceId === skill.resourceId)
        )
          return previous;
        const effectiveExpiry =
          previous?.key === key && selected.length
            ? new Date(
                Math.min(Date.parse(previous.expiresAt), Date.parse(expiresAt))
              ).toISOString()
            : expiresAt;
        return {
          key,
          skills: [...selected, skill],
          expiresAt: effectiveExpiry
        };
      });
    },
    remove(resourceId: string) {
      setState((previous) =>
        previous?.key === key
          ? {
              ...previous,
              skills: previous.skills.filter(
                (skill) => skill.resourceId !== resourceId
              )
            }
          : previous
      );
    },
    clear() {
      setState(null);
    }
  };
}

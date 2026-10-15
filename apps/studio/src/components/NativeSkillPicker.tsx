"use client";

import { useCallback, type RefObject } from "react";
import {
  NativeSkillPickerCore,
  type NativeSkillKeyboardHandler,
  type NativeSkillPickerScope
} from "@koed/ui/native-skill-picker";
import {
  clientLabel,
  clientResourceErrorMessage,
  discoverClientResources,
  loadClientResourceTargets,
  type ClientResourceCatalog
} from "@/lib/client-resources-client";

export type { NativeSkillKeyboardHandler } from "@koed/ui/native-skill-picker";
export type NativeSkillScope = NativeSkillPickerScope;
export type NativeSkill = ClientResourceCatalog["resources"][number];

/** Studio adapter that resolves and validates the selected native Client scope. */
export function NativeSkillPicker({
  scope,
  query,
  onSelect,
  onDismiss,
  keyboardRef
}: {
  scope: NativeSkillScope;
  query: string;
  onSelect: (skill: NativeSkill, catalogExpiresAt: string) => void;
  onDismiss: () => void;
  keyboardRef: RefObject<NativeSkillKeyboardHandler | null>;
}) {
  const loadCatalog = useCallback(
    async (
      requestedScope: NativeSkillPickerScope,
      signal: AbortSignal
    ): Promise<ClientResourceCatalog> => {
      const targets = await loadClientResourceTargets(signal);
      const matches = targets.filter(
        (target) =>
          (!requestedScope.hostedInstanceId ||
            target.hostedInstanceId === requestedScope.hostedInstanceId) &&
          (!requestedScope.instanceId ||
            target.instanceId === requestedScope.instanceId) &&
          (!requestedScope.provider ||
            target.provider === requestedScope.provider)
      );
      if (matches.length > 1)
        throw new Error(
          "Choose a specific AI Client and computer before selecting a Skill."
        );
      if (matches.length === 0)
        throw new Error(
          requestedScope.hostedInstanceId || requestedScope.instanceId
            ? "The selected AI Client is no longer available on this computer. Choose it again to see its Skills."
            : "Choose an available AI Client to see its Skills."
        );
      const target = matches[0];
      if (target.enabled === false)
        throw new Error(
          "This AI Client is disabled. Enable it in its settings before choosing a Skill."
        );
      if (target.authenticationState === "unauthenticated")
        throw new Error(
          "Sign in through the original AI Client before choosing a Skill."
        );
      const catalog = await discoverClientResources(
        {
          hostedInstanceId: target.hostedInstanceId,
          projectId: requestedScope.projectId
        },
        signal
      );
      if (
        catalog.provider !== target.provider ||
        catalog.aiClientInstanceId !== target.instanceId ||
        catalog.hostedInstanceId !== target.hostedInstanceId ||
        catalog.projectId !== requestedScope.projectId
      )
        throw new Error(
          "The AI Client or Project changed. Refresh its Skills before continuing."
        );
      return catalog;
    },
    []
  );
  const title = `${clientLabel(scope.provider ?? "AI Client")} Skills`;
  return (
    <NativeSkillPickerCore
      scope={scope}
      query={query}
      title={title}
      loadCatalog={loadCatalog}
      onSelect={onSelect}
      onDismiss={onDismiss}
      keyboardRef={keyboardRef}
      formatError={clientResourceErrorMessage}
      loadingMessage="Reading configured Skills…"
      className="absolute bottom-full left-2 z-40 mb-2 max-h-64 w-[min(24rem,calc(100cqw-1rem))] overflow-y-auto rounded-lg border border-border-strong bg-surface p-2 text-foreground shadow-xl"
    />
  );
}

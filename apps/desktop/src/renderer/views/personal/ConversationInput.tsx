import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import {
  useCallback,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode
} from "react";
import {
  NativeSkillPickerCore,
  type NativeSkillKeyboardHandler,
  type NativeSkillPickerScope
} from "@koed/ui";
import type { ManagedConversationDesktopApi } from "../../../ipc/managed-conversation-protocol.js";
import type { useConversationSkills } from "./use-conversation-skills.js";

import { ConversationSettings } from "./ConversationSettings.js";

type ConversationInputAction = {
  kind: "send" | "busy" | "interrupt";
  label: string;
  disabled: boolean;
};

export function ConversationInput({
  action,
  attachments,
  autoFocus = false,
  disabled = false,
  label,
  nativeSkills,
  onChange,
  onSubmit,
  placeholder,
  rows = 1,
  settings,
  value
}: {
  action: ConversationInputAction;
  attachments?: ReactNode;
  autoFocus?: boolean;
  disabled?: boolean;
  label: string;
  nativeSkills?: {
    api: ManagedConversationDesktopApi;
    scope: NativeSkillPickerScope;
    choices: ReturnType<typeof useConversationSkills>;
  };
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  rows?: number;
  settings: ComponentProps<typeof ConversationSettings>;
  value: string;
}) {
  const composingRef = useRef(false);
  const keyboardRef = useRef<NativeSkillKeyboardHandler | null>(null);
  const [dismissed, setDismissed] = useState("");
  const scopeKey = JSON.stringify(nativeSkills?.scope ?? null);
  const slash = value.match(/(?:^|\s)\/([^\s]*)$/u);
  const showSkills = Boolean(
    nativeSkills?.api.resources &&
    slash &&
    dismissed !== `${scopeKey}:${value}` &&
    !disabled
  );
  const resourceApi = nativeSkills?.api;
  const loadCatalog = useCallback(
    async (scope: NativeSkillPickerScope, signal: AbortSignal) => {
      if (!resourceApi?.resources || !scope.instanceId)
        throw new Error(
          "Choose an available AI Client before selecting a Skill."
        );
      const { catalog } = await resourceApi.resources({
        aiClientInstanceId: scope.instanceId,
        projectId: scope.projectId
      });
      if (signal.aborted) throw new Error("Skill discovery was canceled.");
      if (
        catalog.aiClientInstanceId !== scope.instanceId ||
        catalog.hostedInstanceId !==
          (scope.hostedInstanceId ?? scope.instanceId) ||
        catalog.projectId !== scope.projectId ||
        (scope.provider && catalog.provider !== scope.provider)
      )
        throw new Error(
          "The AI Client or Project changed. Refresh its Skills."
        );
      return catalog;
    },
    [resourceApi]
  );
  return (
    <>
      {attachments}
      <div className="personal-managed-composer-field conversation-input">
        {nativeSkills?.choices.skills.length ? (
          <div
            aria-label="Selected Skills"
            className="personal-managed-attachments"
          >
            {nativeSkills.choices.skills.map((skill) => (
              <button
                key={skill.resourceId}
                type="button"
                disabled={disabled}
                onClick={() => nativeSkills.choices.remove(skill.resourceId)}
                aria-label={`Remove Skill ${skill.name}`}
              >
                /{skill.name} ×
              </button>
            ))}
          </div>
        ) : null}
        {nativeSkills?.choices.expired ? (
          <p role="status">
            Skill choices expired. Remove them and select again before sending.
          </p>
        ) : null}
        {showSkills && nativeSkills ? (
          <NativeSkillPickerCore
            scope={nativeSkills.scope}
            query={slash?.[1] ?? ""}
            title="AI Client Skills"
            loadCatalog={loadCatalog}
            keyboardRef={keyboardRef}
            onDismiss={() => setDismissed(`${scopeKey}:${value}`)}
            onSelect={(skill, expiresAt) => {
              nativeSkills.choices.select(skill, expiresAt);
              onChange(value.replace(/(?:^|\s)\/[^\s]*$/u, ""));
            }}
          />
        ) : null}
        <label>
          <span className="sr-only">{label}</span>
          <textarea
            autoFocus={autoFocus}
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.value)}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onKeyDown={(event) => {
              if (showSkills && keyboardRef.current?.(event)) {
                event.preventDefault();
                return;
              }
              const nativeEvent = event.nativeEvent as KeyboardEvent;
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !nativeEvent.isComposing &&
                !composingRef.current
              ) {
                event.preventDefault();
                if (!disabled && !action.disabled && action.kind === "send")
                  onSubmit();
              }
            }}
            placeholder={placeholder}
            rows={rows}
            value={value}
          />
        </label>
        <div className="conversation-input-footer">
          <ConversationSettings {...settings} />
          <button
            aria-label={action.label}
            className="conversation-send"
            disabled={action.disabled}
            onClick={onSubmit}
            title={action.label}
            type="button"
          >
            {action.kind === "interrupt" ? (
              <Square aria-hidden="true" />
            ) : action.kind === "busy" ? (
              <LoaderCircle aria-hidden="true" />
            ) : (
              <ArrowUp aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </>
  );
}

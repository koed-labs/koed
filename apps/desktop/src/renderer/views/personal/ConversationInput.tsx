import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import { useRef, type ComponentProps, type ReactNode } from "react";

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
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  rows?: number;
  settings: ComponentProps<typeof ConversationSettings>;
  value: string;
}) {
  const composingRef = useRef(false);
  return (
    <>
      {attachments}
      <div className="personal-managed-composer-field conversation-input">
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
              const nativeEvent = event.nativeEvent as KeyboardEvent;
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !nativeEvent.isComposing &&
                !composingRef.current
              ) {
                event.preventDefault();
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

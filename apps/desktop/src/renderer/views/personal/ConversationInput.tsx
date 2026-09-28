import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import { useRef, useState, useCallback, useMemo, type ComponentProps, type ReactNode } from "react";

import { ConversationSettings } from "./ConversationSettings.js";
import { slashCommandKeypressIsHandled, findActiveSlashCommand, filterSlashCommands, applySlashCommandReplacement } from "./ai-client-slash-suggestions.js";
import { SlashCommandMenu } from "./SlashCommandMenu.js";
import type { ManagedConversationSlashCommand } from "./ai-client-slash-suggestions.js";

type ConversationInputAction = {
  kind: "send" | "busy" | "interrupt";
  label: string;
  disabled: boolean;
};

type ConversationInputAutocompleteProps = {
  autocompleteOptions?: ManagedConversationSlashCommand[];
  autocompleteLoading?: boolean;
  autocompleteError?: string | null;
  onAutocompleteSelect?: (command: ManagedConversationSlashCommand) => void;
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
  value,
  autocompleteOptions,
  autocompleteLoading,
  autocompleteError,
  onAutocompleteSelect
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
} & ConversationInputAutocompleteProps) {
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [filteredCommands, setFilteredCommands] = useState<ManagedConversationSlashCommand[]>([]);

  const handleAutocompleteSelect = useCallback(
    (command: ManagedConversationSlashCommand) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const cursorIndex = textarea.selectionStart;
      const active = findActiveSlashCommand({ text: textarea.value, cursorIndex });

      if (!active) {
        onAutocompleteSelect?.(command);
        return;
      }

      const newValue = applySlashCommandReplacement({
        text: textarea.value,
        range: active.range,
        commandName: command.name
      });

      onChange(newValue);
      onAutocompleteSelect?.(command);
      setAutocompleteOpen(false);
      setSelectedIndex(-1);
    },
    [onChange, onAutocompleteSelect]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = event.nativeEvent as KeyboardEvent;
      const isComposing = nativeEvent.isComposing || composingRef.current;

      if (
        slashCommandKeypressIsHandled({
          key: event.key,
          open: autocompleteOpen,
          isComposing,
          disabled
        })
      ) {
        event.preventDefault();
        event.stopPropagation();

        if (event.key === "ArrowDown") {
          setSelectedIndex((prev) =>
            prev < filteredCommands.length - 1 ? prev + 1 : 0
          );
        } else if (event.key === "ArrowUp") {
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : filteredCommands.length - 1
          );
        } else if (event.key === "Escape") {
          setAutocompleteOpen(false);
          setSelectedIndex(-1);
        }
        return;
      }

      // Always prevent default on Escape to avoid side effects.
      if (event.key === "Escape") {
        event.preventDefault();
        return;
      }

      // Fallback to normal submit handling.
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !isComposing
      ) {
        event.preventDefault();
        if (!disabled && !action.disabled && action.kind === "send")
          onSubmit();
      }
    },
    [autocompleteOpen, filteredCommands, disabled, action, onSubmit]
  );

  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const text = event.currentTarget.value;
      const cursorIndex = event.currentTarget.selectionStart;
      const active = findActiveSlashCommand({ text, cursorIndex });

      if (active) {
        const filtered = filterSlashCommands(autocompleteOptions ?? [], active.query);
        setFilteredCommands(filtered);
        if (!autocompleteOpen) {
          setAutocompleteOpen(true);
          setSelectedIndex(0);
        } else if (selectedIndex >= filtered.length) {
          setSelectedIndex(-1);
        }
      } else {
        if (autocompleteOpen) {
          setAutocompleteOpen(false);
          setSelectedIndex(-1);
        }
      }

      onChange(text);
    },
    [autocompleteOptions, autocompleteOpen, selectedIndex, onChange]
  );

  const menuOptions = autocompleteOpen ? filteredCommands : [];

  return (
    <>
      {attachments}
      <div className="personal-managed-composer-field conversation-input">
        <label>
          <span className="sr-only">{label}</span>
          <textarea
            ref={textareaRef}
            autoFocus={autoFocus}
            disabled={disabled}
            onChange={handleInputChange}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={rows}
            value={value}
          />
        </label>
        {autocompleteOpen && menuOptions.length > 0 && (
          <div className="ai-suggestion-popover">
            {autocompleteLoading ? (
              <span className="ai-suggestion-loading">Loading commands…</span>
            ) : autocompleteError ? (
              <span className="ai-suggestion-error">{autocompleteError}</span>
            ) : (
              <SlashCommandMenu
                options={menuOptions}
                selectedIndex={selectedIndex}
                onSelect={handleAutocompleteSelect}
              />
            )}
          </div>
        )}
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

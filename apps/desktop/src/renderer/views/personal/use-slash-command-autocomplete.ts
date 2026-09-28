import { useState, useCallback, useRef, useMemo } from "react";

import {
  findActiveSlashCommand,
  filterSlashCommands,
  applySlashCommandReplacement,
  slashCommandKeypressIsHandled
} from "./ai-client-slash-suggestions.js";

import type { ManagedConversationSlashCommand } from "./ai-client-slash-suggestions.js";

export function useSlashCommandAutocomplete({
  commands,
  onChange,
  onSelect
}: {
  commands: ManagedConversationSlashCommand[];
  onChange?: (value: string) => void;
  onSelect?: (command: ManagedConversationSlashCommand) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastTextRef = useRef("");

  const filteredCommands = useMemo(
    () => filterSlashCommands(commands, lastTextRef.current || ""),
    [commands, lastTextRef.current]
  );

  const openMenu = useCallback(() => {
    setIsOpen(true);
    setSelectedIndex(0);
  }, []);

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    setSelectedIndex(-1);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashCommandKeypressIsHandled({
        key: event.key,
        open: isOpen,
        isComposing: event.nativeEvent.isComposing,
        disabled: !isOpen
      })) {
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
        } else if (event.key === "Tab") {
          if (selectedIndex >= 0 && selectedIndex < filteredCommands.length) {
            onSelect?.(filteredCommands[selectedIndex]);
          }
        } else if (event.key === "Enter") {
          if (selectedIndex >= 0 && selectedIndex < filteredCommands.length) {
            onSelect?.(filteredCommands[selectedIndex]);
          }
        } else if (event.key === "Escape") {
          closeMenu();
        }
      }
    },
    [isOpen, filteredCommands, selectedIndex, onSelect, closeMenu]
  );

  const handleInput = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.currentTarget.value;
      const textarea = event.currentTarget;
      const cursorIndex = textarea.selectionStart;

      const active = findActiveSlashCommand({ text: value, cursorIndex });
      lastTextRef.current = active?.query ?? "";

      if (active) {
        if (!isOpen) openMenu();
      } else {
        if (isOpen) closeMenu();
      }

      if (selectedIndex >= filteredCommands.length) {
        setSelectedIndex(-1);
      }

      onChange?.(value);
    },
    [isOpen, openMenu, closeMenu, selectedIndex, filteredCommands.length, onChange]
  );

  const handleSelect = useCallback(
    (command: ManagedConversationSlashCommand) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const value = textarea.value;
      const cursorIndex = textarea.selectionStart;
      const active = findActiveSlashCommand({ text: value, cursorIndex });

      if (!active) {
        onSelect?.(command);
        return;
      }

      const newValue = applySlashCommandReplacement({
        text: value,
        range: active.range,
        commandName: command.name
      });

      onChange?.(newValue);
      closeMenu();
      onSelect?.(command);
    },
    [onChange, closeMenu, onSelect]
  );

  return {
    isOpen,
    selectedIndex,
    filteredCommands,
    textareaRef,
    handleKeyDown,
    handleInput,
    handleSelect,
    closeMenu
  };
}

import { useEffect, useRef } from "react";
import { type ManagedConversationSlashCommand } from "./ai-client-slash-suggestions.js";

export function SlashCommandMenu({
  options,
  selectedIndex,
  onSelect,
  onHover
}: {
  options: ManagedConversationSlashCommand[];
  selectedIndex: number;
  onSelect: (command: ManagedConversationSlashCommand) => void;
  onHover?: (index: number) => void;
}) {
  const menuRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const selected = menuRef.current?.children.item(selectedIndex);
    if (selected instanceof HTMLElement) {
      selected.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
  }, [selectedIndex, options]);

  if (options.length === 0) return null;

  return (
    <ul ref={menuRef} className="ai-suggestion-menu" role="listbox">
      {options.map((cmd, index) => (
        <li
          key={cmd.name}
          role="option"
          aria-selected={index === selectedIndex}
          className={`ai-suggestion-item${index === selectedIndex ? " ai-suggestion-item-selected" : ""}`}
          onMouseEnter={() => onHover?.(index)}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(cmd);
          }}
        >
          <span className="ai-suggestion-name">{cmd.name}</span>
          <span className="ai-suggestion-description">{cmd.description}</span>
          <span className="ai-suggestion-scope">
            {cmd.scope === "global" ? "Global" : "Project"}
          </span>
          {cmd.argumentHint && (
            <span className="ai-suggestion-hint">{cmd.argumentHint}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

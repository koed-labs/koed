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
  if (options.length === 0) return null;

  return (
    <ul className="ai-suggestion-menu" role="listbox">
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

import { Dialog, DialogPopup } from "@koed/ui";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { DesktopCommand } from "./command-palette.js";

export function CommandPalette({
  commands,
  onInvoke,
  onOpenChange,
  open
}: {
  commands: readonly DesktopCommand[];
  onInvoke: (command: DesktopCommand) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const normalized = query.normalize("NFC").trim().toLocaleLowerCase();
    if (!normalized) return commands;
    return commands.filter(({ label, scope }) =>
      `${label} ${scope}`.toLocaleLowerCase().includes(normalized)
    );
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setActiveIndex((current) =>
      Math.min(current, Math.max(filtered.length - 1, 0))
    );
  }, [filtered.length]);

  const invoke = (command: DesktopCommand | undefined) => {
    if (!command) return;
    onInvoke(command);
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup
        aria-label="Search and commands"
        className="desktop-command-dialog"
        initialFocus={inputRef}
      >
        <label className="desktop-command-search">
          <Search aria-hidden="true" />
          <input
            aria-activedescendant={
              filtered[activeIndex]
                ? `desktop-command-${filtered[activeIndex].id}`
                : undefined
            }
            aria-autocomplete="list"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((current) =>
                  Math.min(current + 1, filtered.length - 1)
                );
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) => Math.max(current - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                invoke(filtered[activeIndex]);
              }
            }}
            placeholder="Go to a conversation, Workspace, or view"
            ref={inputRef}
            role="combobox"
            type="search"
            value={query}
          />
        </label>
        <div
          aria-label="Available destinations"
          className="desktop-command-list"
          role="listbox"
        >
          {filtered.length ? (
            filtered.map((command, index) => (
              <button
                aria-selected={activeIndex === index}
                id={`desktop-command-${command.id}`}
                key={command.id}
                onClick={() => invoke(command)}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
                type="button"
              >
                <span>{command.label}</span>
                <small>{command.scope}</small>
              </button>
            ))
          ) : (
            <p>No authorized destinations match.</p>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

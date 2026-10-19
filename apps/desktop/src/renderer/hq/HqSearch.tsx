import { Dialog, DialogPopup } from "@koed/ui";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { HqCommand } from "./hq-command-palette.js";

export function HqSearch({
  destinations,
  open,
  onOpenChange,
  onInvoke
}: {
  destinations: readonly HqCommand[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvoke: (command: HqCommand) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);
  const normalized = query.normalize("NFC").trim().toLocaleLowerCase();
  const filtered = destinations.filter(({ label, scope }) =>
    `${label} ${scope}`.toLocaleLowerCase().includes(normalized)
  );
  const index = Math.min(active, Math.max(0, filtered.length - 1));
  const select = (destination?: HqCommand) => {
    if (destination) {
      onInvoke(destination);
      onOpenChange(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        aria-label="Search and commands"
        data-hq-shell=""
        className="hq-search"
        initialFocus={inputRef}
      >
        <label className="hq-search__input">
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            aria-label="Search Projects, Conversations, and commands"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="hq-search-results"
            aria-expanded={open}
            aria-activedescendant={
              filtered[index] ? `hq-search-${filtered[index].id}` : undefined
            }
            type="search"
            placeholder="Search Projects, Conversations, and commands"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActive(
                  Math.max(
                    0,
                    Math.min(
                      filtered.length - 1,
                      index + (event.key === "ArrowDown" ? 1 : -1)
                    )
                  )
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                select(filtered[index]);
              }
            }}
          />
        </label>
        <div
          role="listbox"
          aria-label="HQ destinations"
          id="hq-search-results"
          className="hq-search__results"
        >
          {filtered.map((item, itemIndex) => (
            <button
              type="button"
              role="option"
              aria-selected={index === itemIndex}
              id={`hq-search-${item.id}`}
              key={item.id}
              onMouseEnter={() => setActive(itemIndex)}
              onClick={() => select(item)}
            >
              <span>{item.label}</span>
              <small>{item.scope}</small>
            </button>
          ))}
          {!filtered.length ? <p>No matching destinations.</p> : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

"use client";

import { ChevronDown, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";

export type RepositoryPickerOption = {
  id: string;
  fullName: string;
  private: boolean;
};

export function filterRepositoryOptions(
  repositories: RepositoryPickerOption[],
  query: string
) {
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  if (!normalizedQuery) return repositories;
  return repositories.filter((repository) =>
    repository.fullName.toLocaleLowerCase("en-US").includes(normalizedQuery)
  );
}

export function RepositoryPicker({
  repositories,
  value,
  disabled,
  onSelect
}: {
  repositories: RepositoryPickerOption[];
  value: RepositoryPickerOption | null;
  disabled?: boolean;
  onSelect: (repository: RepositoryPickerOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const listId = `repository-picker-${useId().replace(/:/g, "")}`;
  const filteredRepositories = useMemo(
    () => filterRepositoryOptions(repositories, query),
    [repositories, query]
  );
  const activeRepository = filteredRepositories[activeIndex] ?? null;

  const closePicker = useCallback((restoreFocus = true) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  const openPicker = () => {
    if (disabled) return;
    const currentIndex = value
      ? repositories.findIndex((repository) => repository.id === value.id)
      : 0;
    setQuery("");
    setActiveIndex(Math.max(0, currentIndex));
    setOpen(true);
  };

  const chooseRepository = (repository: RepositoryPickerOption) => {
    onSelect(repository);
    closePicker();
  };

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !buttonRef.current?.parentElement?.contains(target)
      ) {
        closePicker(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePicker();
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closePicker, open]);

  useEffect(() => {
    // Keep keyboard focus inside the filtered result set.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveIndex((current) =>
      filteredRepositories.length === 0
        ? 0
        : Math.min(current, filteredRepositories.length - 1)
    );
  }, [filteredRepositories.length]);

  useEffect(() => {
    if (!open || !activeRepository) return;
    optionRefs.current[activeRepository.id]?.scrollIntoView({ block: "nearest" });
  }, [activeRepository, open]);

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) =>
        filteredRepositories.length === 0
          ? 0
          : Math.min(current + 1, filteredRepositories.length - 1)
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" && activeRepository) {
      event.preventDefault();
      chooseRepository(activeRepository);
    }
  };

  return (
    <div className="relative w-full max-w-[240px] shrink-0">
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-label="Select repository"
        disabled={disabled}
        onClick={() => (open ? closePicker() : openPicker())}
        onKeyDown={(event) => {
          if (
            (event.key === "ArrowDown" || event.key === "Enter") &&
            !open
          ) {
            event.preventDefault();
            openPicker();
          }
        }}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-left text-sm text-foreground outline-none hover:bg-surface-hover focus:border-border-strong focus:ring-1 focus:ring-accent disabled:opacity-60"
      >
        <span className="min-w-0 truncate">
          {value?.fullName ?? "Select repository"}
          {value?.private ? " · private" : ""}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-subtle transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-30 mt-2 w-full max-w-[calc(100vw-2rem)] rounded-xl border border-border-strong bg-surface p-2 shadow-xl shadow-black/50"
        >
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onInputKeyDown}
              placeholder="Search repositories"
              aria-label="Search repositories"
              aria-controls={listId}
              aria-activedescendant={
                activeRepository ? `${listId}-${activeRepository.id}` : undefined
              }
              className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-xs text-foreground outline-none placeholder:text-subtle focus:border-border-strong focus:ring-1 focus:ring-accent"
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label="Repositories"
            className="mt-2 max-h-[min(16rem,calc(100vh-9rem))] overflow-y-auto"
          >
            {filteredRepositories.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-subtle">
                No repositories match.
              </p>
            ) : (
              filteredRepositories.map((repository, index) => (
                <div
                  key={repository.id}
                  ref={(element) => {
                    optionRefs.current[repository.id] = element;
                  }}
                  id={`${listId}-${repository.id}`}
                  role="option"
                  aria-selected={value?.id === repository.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => chooseRepository(repository)}
                  className={`flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-2 text-xs ${index === activeIndex ? "bg-surface-hover text-foreground" : "text-foreground-secondary hover:bg-surface-hover/70"}`}
                >
                  <span className="min-w-0 truncate">{repository.fullName}</span>
                  {value?.id === repository.id && (
                    <span className="shrink-0 text-accent">Current</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

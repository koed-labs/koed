import { CalendarDays } from "lucide-react";
import { useEffect, useRef } from "react";
import { dueChip, dueChoiceDate } from "./hq-due-model.js";
import "./hq-due.css";

type Choice = "today" | "tomorrow" | "friday" | "next week" | "no date";
const choices: readonly [Choice, string][] = [
  ["today", "Today"],
  ["tomorrow", "Tomorrow"],
  ["friday", "Friday"],
  ["next week", "Next week"],
  ["no date", "No date"]
];

export function HqDueControl({
  title,
  dueOn,
  timeZone,
  now,
  open,
  onOpenChange,
  onSelect,
  onSend,
  disabled = false
}: {
  title: string;
  dueOn: string | null;
  timeZone: string;
  now: Date;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (dueOn: string | null) => Promise<void> | void;
  onSend?: () => void;
  disabled?: boolean;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const info = dueChip(dueOn, timeZone, now);
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus()
    );
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onOpenChange(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keyboard);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keyboard);
    };
  }, [open, onOpenChange]);
  if (!info && !open) return null;
  return (
    <span ref={root} className="hq-due">
      <button
        ref={trigger}
        type="button"
        className={`hq-due__trigger hq-due__trigger--${info?.[0] ?? "empty"}`}
        aria-label={`${info ? `${info[1]}. Change` : "Set"} due date for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        <CalendarDays size={11} aria-hidden="true" />
        {info?.[1] ?? "Due"}
      </button>
      {open ? (
        <span
          role="menu"
          className="hq-due__menu"
          aria-label={`Due date for ${title}`}
        >
          <strong>Due{info ? ` · ${info[1].replace(/^Due /, "")}` : ""}</strong>
          <span className="hq-due__choices">
            {choices
              .filter(([choice]) => choice !== "no date" || dueOn)
              .map(([choice, label]) => (
                <button
                  key={choice}
                  type="button"
                  role="menuitem"
                  disabled={disabled}
                  onClick={() => {
                    const date = dueChoiceDate(choice, timeZone, new Date());
                    onOpenChange(false);
                    void onSelect(date);
                  }}
                >
                  {label}
                </button>
              ))}
          </span>
          {onSend ? (
            <button
              type="button"
              role="menuitem"
              className="hq-due__send"
              onClick={() => {
                onOpenChange(false);
                onSend();
              }}
            >
              Send to an Agent
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

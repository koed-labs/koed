"use client";

import type { ReactNode } from "react";

export function SelectionTypeCard({
  selected,
  icon,
  title,
  description,
  onClick,
  disabled = false,
  variant
}: {
  selected: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
  variant: "project" | "channel";
}) {
  const className =
    variant === "project"
      ? `rounded-xl border p-4 text-left transition-colors ${
          selected
            ? "border-accent bg-accent/10"
            : "border-border bg-background/30 hover:border-border-strong"
        } ${disabled ? "cursor-not-allowed opacity-50" : ""}`
      : `rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          selected
            ? "border-accent bg-accent/10"
            : "border-border bg-background/30 hover:border-border-strong disabled:hover:border-border"
        }`;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={className}
    >
      <div className="mb-6 flex items-start justify-between">
        <span className={selected ? "text-accent" : "text-subtle"}>{icon}</span>
        <span
          className={`flex h-4 w-4 items-center justify-center rounded-full border ${
            selected ? "border-accent bg-accent" : "border-border-strong"
          }`}
        >
          {selected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
        </span>
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-subtle">{description}</p>
    </button>
  );
}

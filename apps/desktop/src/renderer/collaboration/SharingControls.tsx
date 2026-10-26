import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuPopup,
  DropdownMenuTrigger
} from "@koed/ui";
import { ChevronRight, Ellipsis } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type {
  SharedMemoryFidelityCeiling,
  SharedMemoryRepresentation
} from "@koed/shared";
import "./sharing-controls.css";

export const sharingDetailTitle = (detail: SharedMemoryRepresentation) =>
  detail === "curated_assertions"
    ? "Curated Memory"
    : detail === "lcm_rollups"
      ? "Overview summaries"
      : detail === "lcm_leaves"
        ? "Detailed summaries"
        : "Memory Events";

export const sharingDetailDescription = (
  detail: SharedMemoryFidelityCeiling
) =>
  detail === "lcm_rollups"
    ? "LCM Rollups"
    : detail === "lcm_leaves"
      ? "Up to LCM Leaves"
      : "Includes summaries";

export function SharingDetailChoices({
  value,
  onChange,
  disabled = false
}: {
  value: SharedMemoryFidelityCeiling;
  onChange: (detail: SharedMemoryFidelityCeiling) => void;
  disabled?: boolean;
}) {
  const groupName = useId();
  return (
    <fieldset className="collab-sharing-choices">
      <legend>Shared detail</legend>
      {(["lcm_rollups", "lcm_leaves", "memory_events"] as const).map(
        (detail) => (
          <label key={detail} className="collab-sharing-choice">
            <input
              type="radio"
              name={groupName}
              aria-label={sharingDetailTitle(detail)}
              checked={detail === value}
              disabled={disabled}
              onChange={() => onChange(detail)}
            />
            <span>
              <strong>{sharingDetailTitle(detail)}</strong>
              <small>{sharingDetailDescription(detail)}</small>
            </span>
          </label>
        )
      )}
    </fieldset>
  );
}

export function SharingRow({
  label,
  value,
  onClick,
  disabled = false
}: {
  label: string;
  value: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const content = (
    <>
      <span>{label}</span>
      <span>
        {value}
        {onClick ? <ChevronRight aria-hidden="true" /> : null}
      </span>
    </>
  );
  return onClick ? (
    <button
      className="collab-sharing-row"
      aria-label={`Change ${label.toLocaleLowerCase()}`}
      type="button"
      onClick={onClick}
      disabled={disabled}
    >
      {content}
    </button>
  ) : (
    <div className="collab-sharing-row">{content}</div>
  );
}

export type SharingAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

export function SharingMoreActions({ actions }: { actions: SharingAction[] }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null
  );
  useEffect(() => {
    setPortalContainer(
      triggerRef.current?.closest<HTMLElement>('[role="dialog"]') ?? null
    );
  }, [actions.length]);
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="More sharing actions"
        className="secondary collab-sharing-more"
        ref={triggerRef}
      >
        <Ellipsis aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuPopup
        align="end"
        side="top"
        portalContainer={portalContainer ?? undefined}
      >
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuPopup>
    </DropdownMenu>
  );
}
